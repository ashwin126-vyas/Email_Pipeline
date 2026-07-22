// Thin wrapper around Brevo's transactional email REST API.
// Docs: https://developers.brevo.com/reference/sendtransacemail
//
// No SDK — just fetch. One send = one POST to /v3/smtp/email.

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

function getSender() {
  const email = process.env.BREVO_SENDER_EMAIL;
  const name = process.env.BREVO_SENDER_NAME || undefined;
  if (!email) {
    throw new Error(
      "BREVO_SENDER_EMAIL is not set (must be a sender verified in Brevo)."
    );
  }
  return { email, name };
}

/**
 * Send one email via Brevo.
 * @param {object} args
 * @param {string} args.to        recipient email
 * @param {string} [args.toName]  recipient display name
 * @param {string} args.subject
 * @param {string} args.html      HTML body
 * @param {string} [args.text]    optional plain-text body
 * @param {object} [args.headers] optional custom SMTP headers (e.g. List-Unsubscribe)
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string, status?: number}>}
 */
export async function sendEmail({ to, toName, subject, html, text, headers }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "BREVO_API_KEY is not set." };
  }
  if (!to) return { ok: false, error: "Missing recipient email." };
  if (!subject) return { ok: false, error: "Missing subject." };
  if (!html && !text) return { ok: false, error: "Missing email body." };

  let sender;
  try {
    sender = getSender();
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const payload = {
    sender,
    to: [toName ? { email: to, name: toName } : { email: to }],
    subject,
    ...(html ? { htmlContent: html } : {}),
    ...(text ? { textContent: text } : {}),
    // Custom headers (List-Unsubscribe / List-Unsubscribe-Post for bulk-sender
    // compliance). Brevo forwards a `headers` object verbatim onto the message.
    ...(headers && Object.keys(headers).length ? { headers } : {}),
  };

  if (process.env.BREVO_REPLY_TO) {
    payload.replyTo = { email: process.env.BREVO_REPLY_TO };
  }

  try {
    const res = await fetch(BREVO_ENDPOINT, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // Brevo error shape: { code, message }
      return {
        ok: false,
        status: res.status,
        error: data?.message || `Brevo returned HTTP ${res.status}`,
      };
    }

    return { ok: true, messageId: data?.messageId };
  } catch (e) {
    return { ok: false, error: e.message || "Network error calling Brevo." };
  }
}

/**
 * Fill {{token}} placeholders in a template with values from a contact.
 * Supported tokens: name, first_name, company, title, email.
 * Unknown tokens are left as-is.
 */
export function renderTemplate(template, contact) {
  if (!template) return template;
  const firstName = (contact.name || "").trim().split(/\s+/)[0] || "";
  const map = {
    name: contact.name || "",
    first_name: firstName,
    company: contact.company || "",
    title: contact.title || "",
    email: contact.email || "",
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key) =>
    key in map ? map[key] : whole
  );
}
