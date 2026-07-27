// Recording inbound replies into `email_replies`.
//
// `email_logs` is what we SENT; this is what came BACK. There is no mail-fetching
// here — this module takes an already-extracted reply (sender, subject, body) and
// is deliberately transport-agnostic, so whatever ends up delivering replies
// (an API call, a paste-in form, a webhook later) reuses the same path.
//
// Ordering rule: PERSIST BEFORE ACTING. The reply is the evidence; stopping a
// sequence is only its consequence, and must never be the only trace that it
// happened.

// Relative imports (not the `@/` alias) so plain Node can load this too — the
// worker imports src/lib/*.js directly, and the alias only resolves under Next.
import { pool } from "./db.js";
import { addSuppression } from "./suppress.js";
import { classifyReply } from "./classify.js";

// Resolve a sender address to who they are, plus which of their sequences (if
// any) is still running. Returns null for addresses that aren't contacts at all,
// so unrelated mail never lands in the table.
//
// Matches on `contacts` rather than on active enrollments on purpose: a reply
// that arrives after the sequence already finished is still a lead, and there is
// simply no active enrollment left to act on. Ordering puts an active enrollment
// first so that is what the reply links to.
export async function lookupSender(email) {
  const { rows } = await pool.query(
    `SELECT c.apollo_id,
            e.id          AS enrollment_id,
            e.campaign_id AS campaign_id,
            e.status      AS enrollment_status
       FROM contacts c
       LEFT JOIN enrollments e ON e.apollo_id = c.apollo_id
      WHERE lower(c.email) = $1
      ORDER BY (e.status = 'active') DESC NULLS LAST, e.updated_at DESC NULLS LAST`,
    [String(email || "").toLowerCase()]
  );
  if (rows.length === 0) return null;
  return {
    apolloId: rows[0].apollo_id,
    enrollmentId: rows[0].enrollment_id,
    campaignId: rows[0].campaign_id,
    activeApolloIds: [
      ...new Set(
        rows.filter((r) => r.enrollment_status === "active").map((r) => r.apollo_id)
      ),
    ],
  };
}

// One row per inbound message. ON CONFLICT covers the same message being
// submitted twice (the unique index is on message_id, where non-null).
async function insertReply(r) {
  const { rows } = await pool.query(
    `INSERT INTO email_replies
       (apollo_id, email, subject, body, classification, action_taken,
        message_id, enrollment_id, campaign_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [r.apollo_id, r.email, r.subject, r.body, r.classification, r.action_taken,
     r.message_id, r.enrollment_id, r.campaign_id]
  );
  return rows[0]?.id ?? null; // null => duplicate message_id, already stored
}

async function stopByApolloIds(apolloIds, status) {
  await pool.query(
    `UPDATE enrollments SET status = $1, updated_at = now()
      WHERE status = 'active' AND apollo_id = ANY($2)`,
    [status, apolloIds]
  );
}

async function deferEnrollments(apolloIds, days) {
  await pool.query(
    `UPDATE enrollments
        SET next_action_at = now() + ($1 * interval '1 day'), updated_at = now()
      WHERE status = 'active' AND apollo_id = ANY($2)`,
    [days, apolloIds]
  );
}

// Record one reply. `{ email, subject, body, messageId? }`.
//
// `classify: false` skips the AI call entirely (useful for bulk imports, or when
// no provider key is set). Classification is best-effort either way: a failure
// downgrades the label to null and the reply is still stored, because losing the
// reply is far worse than losing its label.
//
// Returns { stored, duplicate, replyId, classification, action, apolloId }.
export async function recordReply({ email, subject = "", body = "", messageId = null, classify = true }) {
  const from = String(email || "").trim().toLowerCase();
  if (!from) return { stored: false, reason: "no sender address" };

  const known = await lookupSender(from);
  if (!known) return { stored: false, reason: "sender is not a known contact" };

  let label = null;
  if (classify) {
    try {
      const c = await classifyReply({ subject, body });
      label = c?.label || null;
    } catch {
      label = null; // AI unavailable — store it anyway
    }
  }

  // Only sequences still running can be acted on.
  const apolloIds = known.activeApolloIds;
  const actionable = apolloIds.length > 0;
  const action = !actionable
    ? "none"
    : label === "out_of_office"
      ? "deferred"
      : label === "unsubscribe"
        ? "unsubscribed"
        : "stopped";

  const replyId = await insertReply({
    apollo_id: known.apolloId,
    email: from,
    subject,
    body,
    classification: label,
    action_taken: action,
    message_id: messageId,
    enrollment_id: known.enrollmentId,
    campaign_id: known.campaignId,
  });

  if (actionable) {
    if (label === "out_of_office") {
      const days = parseInt(process.env.OOO_DEFER_DAYS || "3", 10) || 3;
      await deferEnrollments(apolloIds, days);
    } else {
      // interested / not_interested / other / unsubscribe / (null => any-reply-stop)
      const status = label === "unsubscribe" ? "unsubscribed" : "replied";
      await stopByApolloIds(apolloIds, status);
      await addSuppression(pool, { email: from, reason: status });
    }
  }

  return {
    stored: true,
    duplicate: replyId === null,
    replyId,
    classification: label,
    action,
    apolloId: known.apolloId,
  };
}
