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

async function handleMessage(source) {
  const parsed = await simpleParser(source);
  const from = parsed.from?.value?.[0]?.address?.toLowerCase();
  if (!from) return false;

  // Only act if this sender maps to an ACTIVE enrollment (ignore auto-replies
  // and mail from anyone we aren't currently sequencing).
  const apolloIds = await enrolledApolloIds(from);
  if (apolloIds.length === 0) return false;

  const subject = parsed.subject || "";
  const body = parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "";

  const classified = await classifyReply({ subject, body });
  const label = classified?.label || null; // null => AI unavailable/failed

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
    // Flag for a human — this is the one you actually want to answer.
    log(`⭐ INTERESTED reply from ${from} (${apolloIds.join(", ")}) — needs human follow-up`);
  } else {
    log(`reply from ${from} classified "${label || "any-reply(no AI)"}" — enrollment ${status}`);
  }
  return true;
}

async function enrolledApolloIds(email) {
  const { rows } = await pool.query(
    `SELECT DISTINCT e.apollo_id
       FROM enrollments e
      WHERE e.status = 'active'
        AND e.apollo_id IN (SELECT apollo_id FROM contacts WHERE lower(email) = $1)`,
    [email]
  );
  return rows.map((r) => r.apollo_id);
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
