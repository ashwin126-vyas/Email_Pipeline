import { pool } from "@/lib/db";
import { sendEmail, renderTemplate } from "@/lib/brevo";

// POST /api/send-test
// Body: { name?, email, subject, html, text?, templateId? }
//
// The DEMO / test path. UNLIKE /api/send (which never trusts a client-supplied
// address and looks contacts up fresh in the DB), this route sends to the exact
// address typed in the UI — on purpose, so you can email yourself a test before
// touching real contacts. It logs the attempt into email_sends with
// apollo_id = 'demo' so it shows up (marked) in Sent history like any other send.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = (body.name || "").trim();
  const email = (body.email || "").trim();
  const { subject, html, text } = body;
  const templateId = Number.isInteger(body.templateId) ? body.templateId : null;

  if (!email) {
    return Response.json({ error: "A test email address is required." }, { status: 400 });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: `"${email}" is not a valid email address.` }, { status: 400 });
  }
  if (!subject || !(html || text)) {
    return Response.json(
      { error: "subject and a body (html or text) are required." },
      { status: 400 }
    );
  }

  // A synthetic contact so the same {{token}} personalization applies.
  const contact = { apollo_id: "demo", name, email, company: "", title: "" };
  const renderedSubject = renderTemplate(subject, contact);

  const r = await sendEmail({
    to: email,
    toName: name || undefined,
    subject: renderedSubject,
    html: html ? renderTemplate(html, contact) : undefined,
    text: text ? renderTemplate(text, contact) : undefined,
  });

  // Log the test send (never let a logging failure sink the response).
  try {
    await pool.query(
      `INSERT INTO email_sends
         (apollo_id, email, name, company, subject, status, message_id, error, template_id)
       VALUES ('demo', $1, $2, 'Demo (test)', $3, $4, $5, $6, $7)`,
      [
        email,
        name || null,
        renderedSubject,
        r.ok ? "sent" : "failed",
        r.ok ? r.messageId || null : null,
        r.ok ? null : r.error || "Unknown error",
        templateId,
      ]
    );
  } catch {
    /* history logging is best-effort */
  }

  return Response.json({
    ok: r.ok,
    messageId: r.messageId || null,
    error: r.ok ? null : r.error || "Unknown error",
  });
}
