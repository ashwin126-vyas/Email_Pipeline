import { pool } from "@/lib/db";
import { sendEmail, renderTemplate } from "@/lib/brevo";
import { htmlFromBody } from "@/lib/htmlBody";

// How many emails to have in flight against Brevo at once. Keep this modest so
// we don't trip Brevo's rate limits on large bulk sends.
const CONCURRENCY = 5;

// POST /api/send
// Body: { ids: string[], subject?, html?, text?, templateId?,
//         prefer_generated?: boolean, allow_rejected?: boolean }
//   ids     — apollo_id values of the contacts to email (1 for a single send,
//             many for a bulk/range send)
//   subject — supports {{name}} {{first_name}} {{company}} {{title}} tokens
//   html    — HTML body, same tokens supported
//   text    — optional plain-text alternative, same tokens
//
//   prefer_generated — send each contact the email that was already GENERATED
//     for them (newest row in `email_testing`, matched on email), falling back
//     to the subject/html above for anyone who has none. Sending never
//     generates: the email that goes out is the one that was reviewed in
//     Preview, not a fresh one written at send time.
//   allow_rejected — a generated draft that failed a validation gate is refused
//     by default. This is the caller saying "I read it, send it anyway".
//
// Emails are looked up fresh from the `contacts` table by apollo_id (we never
// trust a client-supplied address), personalized per recipient, and sent one
// Brevo request each. Returns a per-recipient result array.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter(Boolean).map(String)
    : [];
  const { subject, html, text } = body;
  const templateId = Number.isInteger(body.templateId) ? body.templateId : null;
  const preferGenerated = Boolean(body.prefer_generated);
  const allowRejected = Boolean(body.allow_rejected);
  const hasDraft = Boolean(subject && (html || text));

  if (ids.length === 0) {
    return Response.json({ error: "No recipient ids provided." }, { status: 400 });
  }
  // Without prefer_generated there is nothing to send but the draft, so it is
  // still required. With it, a run that sends only generated emails is valid.
  if (!preferGenerated && !hasDraft) {
    return Response.json(
      { error: "subject and a body (html or text) are required." },
      { status: 400 }
    );
  }

  // Load the real, current contact rows for these ids.
  let contacts;
  try {
    const { rows } = await pool.query(
      `SELECT apollo_id, name, title, company, email
       FROM contacts
       WHERE apollo_id = ANY($1)
         AND email IS NOT NULL
         AND email <> ''
         AND email NOT ILIKE '%not_unlocked%'`,
      [ids]
    );
    contacts = rows;
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }

  if (contacts.length === 0) {
    return Response.json(
      { error: "None of the given ids map to a contact with a usable email." },
      { status: 404 }
    );
  }

  // The newest generated email per address. One query for the whole batch —
  // the selection can be thousands of contacts, and the client cannot be
  // expected to know which of them have been generated for.
  const generated = new Map();
  if (preferGenerated) {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (lower(person_email))
                lower(person_email) AS key, id, subject, body, is_valid
           FROM email_testing
          WHERE person_email IS NOT NULL
            AND subject IS NOT NULL AND body IS NOT NULL
            AND lower(person_email) = ANY($1)
          ORDER BY lower(person_email), created_at DESC`,
        [contacts.map((c) => c.email.toLowerCase())]
      );
      rows.forEach((r) => generated.set(r.key, r));
    } catch (e) {
      // No email_testing table yet is not a reason to refuse a draft send.
      if (!/does not exist/i.test(e.message)) throw e;
    }
  }

  const results = [];

  // Simple concurrency-limited fan-out.
  for (let i = 0; i < contacts.length; i += CONCURRENCY) {
    const chunk = contacts.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      chunk.map(async (c) => {
        const gen = generated.get(c.email.toLowerCase());
        const base = { id: c.apollo_id, email: c.email, name: c.name };

        // Pick what this contact actually gets, and refuse rather than
        // substitute: silently posting a different email than the one that was
        // previewed is worse than sending nothing.
        let source, renderedSubject, renderedText, renderedHtml;
        if (gen && (gen.is_valid || allowRejected)) {
          source = "generated";
          renderedSubject = gen.subject;
          renderedText = gen.body;
          renderedHtml = htmlFromBody(gen.body);
        } else if (gen) {
          return {
            ...base,
            ok: false,
            source: "generated",
            error: "Generated draft failed a validation gate — open Preview to review it first.",
          };
        } else if (hasDraft) {
          source = "draft";
          renderedSubject = renderTemplate(subject, c);
          renderedText = text ? renderTemplate(text, c) : null;
          renderedHtml = html ? renderTemplate(html, c) : undefined;
        } else {
          return {
            ...base,
            ok: false,
            source: "none",
            error: "No generated email for this contact, and no email set.",
          };
        }

        const r = await sendEmail({
          to: c.email,
          toName: c.name || undefined,
          subject: renderedSubject,
          html: renderedHtml || undefined,
          text: renderedText || undefined,
        });
        // Record every attempt (sent OR failed) in the email_logs log. This
        // write must never sink the send itself, so swallow logging errors.
        await logSend(c, renderedSubject, renderedText, r, source === "draft" ? templateId : null).catch(() => {});
        // The generated row is the audit trail for what went out, so stamp it.
        if (r.ok && source === "generated") {
          await pool
            .query(`UPDATE email_testing SET status = 'sent' WHERE id = $1`, [gen.id])
            .catch(() => {});
        }
        return {
          ...base,
          ok: r.ok,
          source,
          messageId: r.messageId || null,
          error: r.ok ? null : r.error || "Unknown error",
        };
      })
    );
    results.push(...settled);
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.length - sent;
  const fromGenerated = results.filter((r) => r.ok && r.source === "generated").length;

  return Response.json({ sent, failed, total: results.length, fromGenerated, results });
}

// Insert one row into email_logs for a single attempt.
async function logSend(contact, renderedSubject, renderedBody, result, templateId) {
  await pool.query(
    `INSERT INTO email_logs
       (email, name, company, subject, body, status, message_id, error, template_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      contact.email,
      contact.name || null,
      contact.company || null,
      renderedSubject,
      renderedBody || null,
      result.ok ? "sent" : "failed",
      result.ok ? result.messageId || null : null,
      result.ok ? null : result.error || "Unknown error",
      templateId,
    ]
  );
}
