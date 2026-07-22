import { pool } from "@/lib/db";
import { sendEmail } from "@/lib/brevo";
import { htmlFromBody } from "@/lib/htmlBody";
import { generateEmail } from "@/lib/generateSequence";
import { isSuppressed } from "@/lib/suppress";
import { unsubscribeHeaders, appendUnsubscribeFooter } from "@/lib/unsubscribe";

export const dynamic = "force-dynamic";

// Generation is slower than a plain send, so keep fewer in flight than /api/send.
const CONCURRENCY = 3;

// POST /api/generate-send
// Body: { ids: string[], brief: { pitch, theme?, tone? }, preview? }
//
// For each contact (looked up FRESH by apollo_id, like /api/send): generate a
// unique email from the campaign brief + that contact's company/title, then send
// it via Brevo and log to email_logs. `preview: true` generates for the FIRST
// id only and returns it WITHOUT sending. Returns the same result shape as
// /api/send so the Recipients UI can reuse its status handling.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean).map(String) : [];
  const brief = body.brief || {};
  const preview = body.preview === true;

  if (!brief.pitch || !brief.pitch.trim()) {
    return Response.json({ error: "A campaign brief (pitch) is required." }, { status: 400 });
  }

  // Demo/test path: generate for a TYPED contact (name/company/title) and send to
  // the typed address — the AI equivalent of /api/send-test, so you can preview a
  // generated email on yourself without touching real contacts.
  if (body.testContact) {
    const tc = body.testContact;
    const email = (tc.email || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return Response.json({ error: `"${email}" is not a valid email address.` }, { status: 400 });
    }
    const contact = {
      apollo_id: "demo",
      name: (tc.name || "").trim(),
      email,
      company: (tc.company || "").trim(),
      title: (tc.title || "").trim(),
    };
    const g = await generateEmail({ productPitch: brief.pitch, theme: brief.theme, tone: brief.tone, contact });
    if (g.error) return Response.json({ error: g.error }, { status: 422 });

    const footer = appendUnsubscribeFooter(htmlFromBody(g.body), g.body, email, { c: "demo" });
    const r = await sendEmail({
      to: email,
      toName: contact.name || undefined,
      subject: g.subject,
      html: footer.html,
      text: footer.text,
      headers: unsubscribeHeaders(email, { c: "demo" }),
    });
    await logSend(contact, g.subject, g.body, r).catch(() => {});
    return Response.json({
      ok: r.ok,
      messageId: r.messageId || null,
      error: r.ok ? null : r.error || "Unknown error",
      subject: g.subject,
      body: g.body,
    });
  }

  if (ids.length === 0) {
    return Response.json({ error: "No recipient ids provided." }, { status: 400 });
  }

  let contacts;
  try {
    const { rows } = await pool.query(
      `SELECT apollo_id, name, title, company, email
         FROM contacts
        WHERE apollo_id = ANY($1)
          AND email IS NOT NULL AND email <> ''
          AND email NOT ILIKE '%not_unlocked%'`,
      [ids]
    );
    // Preserve the caller's id order.
    const byId = new Map(rows.map((r) => [r.apollo_id, r]));
    contacts = ids.map((id) => byId.get(id)).filter(Boolean);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }

  if (contacts.length === 0) {
    return Response.json(
      { error: "None of the given ids map to a contact with a usable email." },
      { status: 404 }
    );
  }

  const gen = (contact) =>
    generateEmail({
      productPitch: brief.pitch,
      theme: brief.theme,
      tone: brief.tone,
      contact,
    });

  // Preview: generate one, return it, send nothing.
  if (preview) {
    const contact = contacts[0];
    const r = await gen(contact);
    if (r.error) return Response.json({ error: r.error }, { status: 422 });
    return Response.json({
      subject: r.subject,
      body: r.body,
      contact: { name: contact.name, email: contact.email, company: contact.company, title: contact.title },
    });
  }

  const results = [];
  for (let i = 0; i < contacts.length; i += CONCURRENCY) {
    const chunk = contacts.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      chunk.map(async (c) => {
        // Never contact a suppressed address.
        try {
          if (await isSuppressed(pool, c.email)) {
            return { id: c.apollo_id, email: c.email, name: c.name, ok: false, error: "On the do-not-contact list." };
          }
        } catch {
          /* if the suppression check itself fails, proceed rather than block */
        }

        const g = await gen(c);
        if (g.error) {
          await logSend(c, g.subject || "(generation failed)", null, { ok: false, error: g.error }).catch(() => {});
          return { id: c.apollo_id, email: c.email, name: c.name, ok: false, error: g.error };
        }

        const footer = appendUnsubscribeFooter(htmlFromBody(g.body), g.body, c.email, { c: c.apollo_id });
        const r = await sendEmail({
          to: c.email,
          toName: c.name || undefined,
          subject: g.subject,
          html: footer.html,
          text: footer.text,
          headers: unsubscribeHeaders(c.email, { c: c.apollo_id }),
        });
        await logSend(c, g.subject, g.body, r).catch(() => {});
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
  return Response.json({ sent, failed: results.length - sent, total: results.length, results });
}

// One email_logs row per attempt. template_id is NULL (AI-generated, not a
// saved template). Errors swallowed by the caller so logging never sinks a send.
async function logSend(contact, subject, body, result) {
  await pool.query(
    `INSERT INTO email_logs
       (email, name, company, subject, body, status, message_id, error, template_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL)`,
    [
      contact.email,
      contact.name || null,
      contact.company || null,
      subject,
      body || null,
      result.ok ? "sent" : "failed",
      result.ok ? result.messageId || null : null,
      result.ok ? null : result.error || "Unknown error",
    ]
  );
}
