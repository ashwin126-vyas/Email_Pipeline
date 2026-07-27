// Reply detection: the moment a contact replies, STOP their sequence — nothing
// looks worse than auto-following-up someone who already answered.
//
// Mechanism: poll the reply mailbox over IMAP for unseen messages, match the
// sender against enrolled contacts, classify the reply with Claude, then act in
// PLAIN CODE. Entirely env-gated: with no IMAP_* configured this is dormant and
// the worker just skips it. With IMAP but no ANTHROPIC_API_KEY it degrades to
// the v1 rule "any reply -> stop".
//
// Env:
//   IMAP_HOST, IMAP_PORT (default 993), IMAP_USER, IMAP_PASS, IMAP_TLS (default true)
//   IMAP_MAILBOX (default INBOX), OOO_DEFER_DAYS (default 3)

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { pool } from "../src/lib/db.js";
import { addSuppression } from "../src/lib/suppress.js";
import { classifyReply } from "../src/lib/classify.js";

const now = () => new Date().toISOString();
function log(...a) {
  console.log(`[reply-scan ${now()}]`, ...a);
}

export function replyScanEnabled() {
  return Boolean(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
}

export async function scanReplies() {
  if (!replyScanEnabled()) return { enabled: false };

  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    secure: process.env.IMAP_TLS !== "false",
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false,
  });

  let handled = 0;
  try {
    await client.connect();
  } catch (e) {
    log("IMAP connect failed:", e.message);
    return { enabled: true, error: e.message };
  }

  const mailbox = process.env.IMAP_MAILBOX || "INBOX";
  const lock = await client.getMailboxLock(mailbox);
  try {
    const uids = await client.search({ seen: false }, { uid: true });
    if (uids && uids.length) {
      const batch = uids.slice(0, 50); // cap work per scan
      for await (const msg of client.fetch(batch, { source: true }, { uid: true })) {
        try {
          if (await handleMessage(msg.source)) handled += 1;
        } catch (e) {
          log("message error:", e.message);
        } finally {
          // Mark seen so we don't reprocess it next scan.
          await client.messageFlagsAdd(msg.uid, ["\\Seen"], { uid: true }).catch(() => {});
        }
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  if (handled) log(`acted on ${handled} reply(ies)`);
  return { enabled: true, handled };
}

// Exported for tests: lets a raw RFC822 message be pushed through the full
// parse → match → classify → store → act path without a live IMAP server.
export async function handleMessage(source) {
  const parsed = await simpleParser(source);
  const from = parsed.from?.value?.[0]?.address?.toLowerCase();
  if (!from) return false;

  // Is this someone we know? Match on `contacts`, not on active enrollments — a
  // reply that arrives after the sequence finished is still a lead worth keeping,
  // and there is no active enrollment left to act on. Unknown senders are skipped
  // so the reply mailbox's own spam/newsletters never land in email_replies.
  const known = await lookupSender(from);
  if (!known) return false;

  const subject = parsed.subject || "";
  const body = parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "";

  // Classification must never be able to lose the reply, so it is wrapped: a
  // thrown AI error would otherwise propagate out of handleMessage, and the
  // caller marks the message \Seen regardless — losing it permanently.
  let classified = null;
  try {
    classified = await classifyReply({ subject, body });
  } catch (e) {
    log(`classify failed for ${from}:`, e.message);
  }
  const label = classified?.label || null; // null => AI unavailable/failed

  // Only sequences still running can be acted on.
  const apolloIds = known.activeApolloIds;
  const actionable = apolloIds.length > 0;

  // Persist BEFORE acting. The reply is the evidence; stopping the sequence is
  // just a consequence of it, and must not be the only trace that it happened.
  await saveReply({
    apollo_id: known.apolloId,
    email: from,
    subject,
    body,
    classification: label,
    action_taken: !actionable
      ? "none"
      : label === "out_of_office"
        ? "deferred"
        : label === "unsubscribe"
          ? "unsubscribed"
          : "stopped",
    message_id: parsed.messageId || null,
    enrollment_id: known.enrollmentId,
    campaign_id: known.campaignId,
  });

  if (!actionable) {
    log(`reply from ${from} classified "${label || "no-AI"}" — stored; no active enrollment to stop`);
    return true;
  }

  if (label === "out_of_office") {
    const days = parseInt(process.env.OOO_DEFER_DAYS || "3", 10) || 3;
    await deferEnrollments(apolloIds, days);
    log(`OOO from ${from} — deferred ${days}d`);
    return true;
  }

  // interested / not_interested / other / unsubscribe / (null => any-reply-stop)
  const status = label === "unsubscribe" ? "unsubscribed" : "replied";
  const reason = label === "unsubscribe" ? "unsubscribed" : "replied";

  await stopByApolloIds(apolloIds, status);
  await addSuppression(pool, { email: from, reason });

  if (label === "interested") {
    // Flag for a human — this is the one you actually want to answer. It is also
    // a row in email_replies now, so it outlives this log line.
    log(`⭐ INTERESTED reply from ${from} (${apolloIds.join(", ")}) — needs human follow-up`);
  } else {
    log(`reply from ${from} classified "${label || "any-reply(no AI)"}" — enrollment ${status}`);
  }
  return true;
}

// Resolve a sender address to who they are, plus which of their sequences (if
// any) is still running. Returns null for addresses that aren't contacts at all.
// Ordering puts an active enrollment first so that is what the reply links to.
async function lookupSender(email) {
  const { rows } = await pool.query(
    `SELECT c.apollo_id,
            e.id          AS enrollment_id,
            e.campaign_id AS campaign_id,
            e.status      AS enrollment_status
       FROM contacts c
       LEFT JOIN enrollments e ON e.apollo_id = c.apollo_id
      WHERE lower(c.email) = $1
      ORDER BY (e.status = 'active') DESC NULLS LAST, e.updated_at DESC NULLS LAST`,
    [email]
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

// One row per inbound message. ON CONFLICT covers a mailbox replaying something
// already stored (the unique index is on message_id, where non-null).
async function saveReply(r) {
  try {
    await pool.query(
      `INSERT INTO email_replies
         (apollo_id, email, subject, body, classification, action_taken,
          message_id, enrollment_id, campaign_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
      [r.apollo_id, r.email, r.subject, r.body, r.classification, r.action_taken,
       r.message_id, r.enrollment_id, r.campaign_id]
    );
  } catch (e) {
    // Mirrors logSend on the send path: a storage failure must never stop the
    // sequence from being stopped, which is the safety-critical half here.
    log("could not store reply:", e.message);
  }
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
