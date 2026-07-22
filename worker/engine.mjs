// The heartbeat's core: one tick = "who is due now, and send them their next
// step." A follow-up is not a separate system — it's the same enrollment row
// becoming due again after we stamped next_action_at forward.
//
// Reuses the app's own modules (no forking): the pg pool, Brevo sender +
// renderTemplate, the plain-text->HTML helper, suppression check, and the
// unsubscribe header/footer builders. Node 22 loads these ESM .js files fine.

import { pool } from "../src/lib/db.js";
import { sendEmail, renderTemplate } from "../src/lib/brevo.js";
import { htmlFromBody } from "../src/lib/htmlBody.js";
import { isSuppressed } from "../src/lib/suppress.js";
import {
  unsubscribeHeaders,
  appendUnsubscribeFooter,
} from "../src/lib/unsubscribe.js";

// Match the manual send path: at most 5 Brevo requests in flight at once.
const CONCURRENCY = 5;

const now = () => new Date().toISOString();
function log(...args) {
  console.log(`[worker ${now()}]`, ...args);
}

// One full pass over every active campaign. Returns a small summary for logging.
// `onlyCampaignId` restricts the pass to a single campaign (used by the
// automation test so it can't touch real campaigns).
export async function runTick({ onlyCampaignId = null } = {}) {
  let campaigns;
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.sequence_id, c.daily_cap,
              c.window_start, c.window_end, c.timezone
         FROM campaigns c
        WHERE c.status = 'active'
          AND ($1::int IS NULL OR c.id = $1)`,
      [onlyCampaignId]
    );
    campaigns = rows;
  } catch (e) {
    log("could not load campaigns:", e.message);
    return { campaigns: 0, sent: 0 };
  }

  let totalSent = 0;
  for (const campaign of campaigns) {
    try {
      totalSent += await processCampaign(campaign);
    } catch (e) {
      log(`campaign #${campaign.id} "${campaign.name}" error:`, e.message);
    }
  }
  return { campaigns: campaigns.length, sent: totalSent };
}

async function processCampaign(campaign) {
  // 1. Send window (in the campaign's own timezone).
  const hour = localHour(campaign.timezone);
  if (!inWindow(hour, campaign.window_start, campaign.window_end)) {
    return 0;
  }

  // 2. Daily cap — how many successful sends already went out "today" locally.
  const { rows: capRows } = await pool.query(
    `SELECT count(*)::int AS n FROM email_logs
      WHERE campaign_id = $1 AND status = 'sent'
        AND sent_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2`,
    [campaign.id, campaign.timezone]
  );
  const remaining = campaign.daily_cap - capRows[0].n;
  if (remaining <= 0) return 0;

  // 3. Claim + send in a single transaction. FOR UPDATE SKIP LOCKED means two
  //    overlapping ticks (or two workers) never grab the same enrollment, and
  //    advancing next_action_at in the SAME transaction as the send-log is what
  //    prevents a crash mid-pass from double-sending.
  const client = await pool.connect();
  let sentCount = 0;
  try {
    await client.query("BEGIN");

    const { rows: due } = await client.query(
      `SELECT id, apollo_id, current_step
         FROM enrollments
        WHERE campaign_id = $1 AND status = 'active' AND next_action_at <= now()
        ORDER BY next_action_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [campaign.id, remaining]
    );

    if (due.length === 0) {
      await client.query("COMMIT");
      return 0;
    }

    // Resolve each due row; anything that can't be sent gets a terminal status.
    const sendable = [];
    for (const en of due) {
      const { rows: cRows } = await client.query(
        `SELECT apollo_id, name, title, company, email
           FROM contacts
          WHERE apollo_id = $1
            AND email IS NOT NULL AND email <> ''
            AND email NOT ILIKE '%not_unlocked%'`,
        [en.apollo_id]
      );
      const contact = cRows[0];
      if (!contact) {
        await setStatus(client, en.id, "completed"); // contact gone; nothing to send
        continue;
      }
      if (await isSuppressed(client, contact.email)) {
        await setStatus(client, en.id, "unsubscribed"); // on do-not-contact
        continue;
      }

      const { rows: sRows } = await client.query(
        `SELECT st.step_number, st.template_id, t.subject, t.body
           FROM sequence_steps st
           JOIN campaigns c ON c.id = $1
           LEFT JOIN email_templates t ON t.id = st.template_id
          WHERE st.sequence_id = c.sequence_id AND st.step_number = $2`,
        [campaign.id, en.current_step]
      );
      const step = sRows[0];
      if (!step) {
        await setStatus(client, en.id, "completed"); // ran off the end of the sequence
        continue;
      }
      if (!step.template_id || step.subject == null) {
        await setStatus(client, en.id, "paused"); // misconfigured step — let an admin fix it
        log(`campaign #${campaign.id} step ${en.current_step} has no template; enrollment #${en.id} paused`);
        continue;
      }
      sendable.push({ en, contact, step });
    }

    // WORKER_DRY_RUN=true exercises the whole loop (claim → render → log →
    // advance/follow-up) WITHOUT calling Brevo — for testing/staging so you can
    // watch the engine work without sending real email. Rows are logged with a
    // "dry-run:" message_id so they're easy to spot and clean up.
    const dryRun = process.env.WORKER_DRY_RUN === "true";

    // Fan out the actual Brevo sends, 5 at a time (no DB use during this).
    const results = [];
    for (let i = 0; i < sendable.length; i += CONCURRENCY) {
      const chunk = sendable.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(
        chunk.map(async ({ en, contact, step }) => {
          const subject = renderTemplate(step.subject, contact);
          const bodyText = renderTemplate(step.body || "", contact);
          const extra = { c: contact.apollo_id };
          const footer = appendUnsubscribeFooter(
            htmlFromBody(bodyText),
            bodyText,
            contact.email,
            extra
          );
          let r;
          if (dryRun) {
            log(`[DRY-RUN] step ${en.current_step} → ${contact.email} — "${subject}"`);
            r = { ok: true, messageId: `dry-run:${Date.now()}` };
          } else {
            r = await sendEmail({
              to: contact.email,
              toName: contact.name || undefined,
              subject,
              html: footer.html,
              text: footer.text,
              headers: unsubscribeHeaders(contact.email, extra),
            });
          }
          return { en, contact, step, subject, bodyText, r };
        })
      );
      results.push(...settled);
    }

    // Log every attempt and advance the enrollment — all still inside the tx.
    for (const { en, contact, step, subject, bodyText, r } of results) {
      await client.query(
        `INSERT INTO email_logs
           (email, name, company, subject, body, status, message_id, error,
            template_id, campaign_id, enrollment_id, step_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          contact.email,
          contact.name || null,
          contact.company || null,
          subject,
          bodyText || null,
          r.ok ? "sent" : "failed",
          r.ok ? r.messageId || null : null,
          r.ok ? null : r.error || "Unknown error",
          step.template_id,
          campaign.id,
          en.id,
          en.current_step,
        ]
      );

      // Advance to the next step (if any). We advance even on a failed send so a
      // transient Brevo error can't wedge the enrollment forever; the failure is
      // recorded in email_logs. Bounces/complaints stop the row via the webhook.
      const { rows: nextRows } = await client.query(
        `SELECT st.delay_hours
           FROM sequence_steps st
           JOIN campaigns c ON c.id = $1
          WHERE st.sequence_id = c.sequence_id AND st.step_number = $2`,
        [campaign.id, en.current_step + 1]
      );
      if (nextRows.length) {
        await client.query(
          `UPDATE enrollments
              SET current_step = $1,
                  next_action_at = now() + ($2 * interval '1 hour'),
                  last_message_id = COALESCE($3, last_message_id),
                  updated_at = now()
            WHERE id = $4`,
          [en.current_step + 1, nextRows[0].delay_hours, r.messageId || null, en.id]
        );
      } else {
        await client.query(
          `UPDATE enrollments
              SET status = 'completed',
                  last_message_id = COALESCE($1, last_message_id),
                  updated_at = now()
            WHERE id = $2`,
          [r.messageId || null, en.id]
        );
      }
      if (r.ok) sentCount += 1;
    }

    await client.query("COMMIT");
    if (results.length) {
      log(`campaign #${campaign.id} "${campaign.name}": ${sentCount}/${results.length} sent (cap left ${remaining})`);
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    log(`campaign #${campaign.id} tx rolled back:`, e.message);
  } finally {
    client.release();
  }
  return sentCount;
}

async function setStatus(client, enrollmentId, status) {
  await client.query(
    `UPDATE enrollments SET status = $1, updated_at = now() WHERE id = $2`,
    [status, enrollmentId]
  );
}

// Current wall-clock hour (0-23) in an IANA timezone. Falls back to UTC if the
// timezone string is invalid.
function localHour(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    let h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "", 10);
    if (h === 24) h = 0; // some ICU builds render midnight as 24
    return Number.isFinite(h) ? h : new Date().getUTCHours();
  } catch {
    return new Date().getUTCHours();
  }
}

// [start, end) local hour window. Supports overnight windows (start > end).
function inWindow(hour, start, end) {
  if (start === end) return true; // 24h
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
