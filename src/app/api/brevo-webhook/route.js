import { pool } from "@/lib/db";
import { addSuppression, stopEnrollments } from "@/lib/suppress";

// Public endpoint Brevo PUSHes delivery events to. Never evaluate at build.
export const dynamic = "force-dynamic";

// POST /api/brevo-webhook?secret=<BREVO_WEBHOOK_SECRET>
//
// Brevo posts one JSON event (occasionally an array) per delivery event. We
// correlate it back to the send row by `message-id` (already stored at send
// time) and stamp the matching timestamp column. Bounces / spam complaints /
// unsubscribes also add the address to `suppressions` and stop its active
// enrollments so the heartbeat leaves that contact alone.
//
// Security: this route is public, so we require a shared secret in the query
// string (configure the same value in the Brevo dashboard webhook URL). We do
// the DB work but always return 200 fast-ish so Brevo doesn't retry-storm.

// Brevo event name -> the email_logs column to stamp.
const EVENT_COLUMN = {
  opened: "opened_at",
  unique_opened: "opened_at",
  click: "clicked_at",
  clicked: "clicked_at",
  hard_bounce: "bounced_at",
  soft_bounce: "bounced_at",
  blocked: "bounced_at",
  invalid_email: "bounced_at",
  spam: "complained_at",
  complaint: "complained_at",
};

// Events that should stop the contact, and the terminal enrollment status.
const STOP_STATUS = {
  hard_bounce: "bounced",
  blocked: "bounced",
  invalid_email: "bounced",
  spam: "unsubscribed",
  complaint: "unsubscribed",
  unsubscribed: "unsubscribed",
};

// Reason recorded on the suppression row.
const SUPPRESS_REASON = {
  hard_bounce: "bounced",
  blocked: "bounced",
  invalid_email: "bounced",
  spam: "complained",
  complaint: "complained",
  unsubscribed: "unsubscribed",
};

export async function POST(req) {
  const secret = process.env.BREVO_WEBHOOK_SECRET;
  if (secret) {
    const given = new URL(req.url).searchParams.get("secret");
    if (given !== secret) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const events = Array.isArray(payload) ? payload : [payload];
  for (const ev of events) {
    try {
      await handleEvent(ev);
    } catch (e) {
      // Never let one bad event fail the whole webhook — Brevo would retry all.
      console.error("[brevo-webhook] event error:", e.message);
    }
  }

  return Response.json({ ok: true, received: events.length });
}

async function handleEvent(ev) {
  const type = String(ev.event || ev.type || "").toLowerCase();
  const email = (ev.email || "").trim().toLowerCase();
  const rawId = ev["message-id"] || ev.message_id || ev.messageId || "";

  // Helpful while wiring the webhook up in the Brevo dashboard the first time.
  console.log(`[brevo-webhook] event=${type} email=${email} message-id=${rawId}`);

  // Stamp the analytics/event column on the matching send row (matched by
  // message-id, tolerating angle brackets which Brevo sometimes includes).
  const column = EVENT_COLUMN[type];
  if (column && rawId) {
    const ids = messageIdVariants(rawId);
    await pool.query(
      `UPDATE email_logs
          SET ${column} = COALESCE(${column}, now())
        WHERE message_id = ANY($1)`,
      [ids]
    );
  }

  // Terminal events: suppress + stop the sequence. Matched by the recipient's
  // email (mapped to enrollments via the contacts table).
  const stopStatus = STOP_STATUS[type];
  if (stopStatus) {
    await addSuppression(pool, {
      email,
      reason: SUPPRESS_REASON[type] || "manual",
    });
    await stopEnrollments(pool, { email, status: stopStatus });
  }
}

// Brevo's message-id may arrive as "<abc@host>" or "abc@host"; match either.
function messageIdVariants(raw) {
  const s = String(raw).trim();
  const stripped = s.replace(/^<|>$/g, "");
  return Array.from(new Set([s, stripped, `<${stripped}>`]));
}
