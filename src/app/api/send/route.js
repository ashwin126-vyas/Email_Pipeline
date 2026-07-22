import { pool } from "@/lib/db";
import { sendEmail, renderTemplate } from "@/lib/brevo";

// How many emails to have in flight against Brevo at once. Keep this modest so
// we don't trip Brevo's rate limits on large bulk sends.
const CONCURRENCY = 5;

// POST /api/send
// Body: { ids: string[], subject, html, text? }
//   ids     — apollo_id values of the contacts to email (1 for a single send,
//             many for a bulk/range send)
//   subject — supports {{name}} {{first_name}} {{company}} {{title}} tokens
//   html    — HTML body, same tokens supported
//   text    — optional plain-text alternative, same tokens
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

  if (ids.length === 0) {
    return Response.json({ error: "No recipient ids provided." }, { status: 400 });
  }
  if (!subject || !(html || text)) {
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

  const results = [];

  // Simple concurrency-limited fan-out.
  for (let i = 0; i < contacts.length; i += CONCURRENCY) {
    const chunk = contacts.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      chunk.map(async (c) => {
        const renderedSubject = renderTemplate(subject, c);
        const renderedText = text ? renderTemplate(text, c) : null;
        const r = await sendEmail({
          to: c.email,
          toName: c.name || undefined,
          subject: renderedSubject,
          html: html ? renderTemplate(html, c) : undefined,
          text: renderedText || undefined,
        });
        // Record every attempt (sent OR failed) in the email_logs log. This
        // write must never sink the send itself, so swallow logging errors.
        await logSend(c, renderedSubject, renderedText, r, templateId).catch(() => {});
        return {
          id: c.apollo_id,
          email: c.email,
          name: c.name,
          ok: r.ok,
          messageId: r.messageId || null,
          error: r.ok ? null : r.error || "Unknown error",
        };
      })
    );
    results.push(...settled);
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.length - sent;

  return Response.json({ sent, failed, total: results.length, results });
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
