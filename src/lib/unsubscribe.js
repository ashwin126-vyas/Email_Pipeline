// Unsubscribe plumbing shared by the send/worker paths and the /api/unsubscribe
// route. Gmail/Yahoo bulk-sender rules effectively require a working
// List-Unsubscribe (with one-click POST) on every marketing/cold email, plus a
// visible unsubscribe link in the body. This module builds all three:
//   1. a per-recipient unsubscribe URL (optionally signed),
//   2. the List-Unsubscribe / List-Unsubscribe-Post headers,
//   3. a footer appended to the rendered HTML + text body.
//
// APP_BASE_URL (e.g. https://mail.radiusai.example) is the public https origin
// the app is reachable at. Without it we can't build an http(s) unsubscribe
// URL, so we fall back to a mailto: unsubscribe only.

import crypto from "node:crypto";

const SECRET = process.env.UNSUB_SECRET || "";

// Deterministic short signature over the email so a one-click unsubscribe link
// can't be trivially forged for an arbitrary address. Only enforced when
// UNSUB_SECRET is set (otherwise unsubscribing is open — still bounded, since
// the worst case is suppressing an address that asked to be left alone).
export function unsubscribeToken(email) {
  if (!SECRET) return "";
  return crypto
    .createHmac("sha256", SECRET)
    .update(String(email || "").toLowerCase())
    .digest("hex")
    .slice(0, 24);
}

export function verifyUnsubscribeToken(email, token) {
  if (!SECRET) return true; // no secret configured → don't gate unsubscribes
  const expected = unsubscribeToken(email);
  if (!expected || !token || expected.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

function baseUrl() {
  return (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
}

// Public one-click unsubscribe URL for an email, or "" if APP_BASE_URL is unset.
export function unsubscribeUrl(email, extra = {}) {
  const base = baseUrl();
  if (!base) return "";
  const params = new URLSearchParams({ e: email });
  const token = unsubscribeToken(email);
  if (token) params.set("s", token);
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== "") params.set(k, String(v));
  }
  return `${base}/api/unsubscribe?${params.toString()}`;
}

// The mailto: fallback (works even without APP_BASE_URL). Replies to this land
// in the reply mailbox and are handled as an unsubscribe by reply detection.
function unsubscribeMailto() {
  const addr = process.env.BREVO_REPLY_TO || process.env.BREVO_SENDER_EMAIL;
  if (!addr) return "";
  return `mailto:${addr}?subject=unsubscribe`;
}

// Build the List-Unsubscribe + List-Unsubscribe-Post headers for a recipient.
// Returns {} if we have neither an http URL nor a mailto to offer.
export function unsubscribeHeaders(email, extra = {}) {
  const parts = [];
  const url = unsubscribeUrl(email, extra);
  const mailto = unsubscribeMailto();
  if (url) parts.push(`<${url}>`);
  if (mailto) parts.push(`<${mailto}>`);
  if (parts.length === 0) return {};
  const headers = { "List-Unsubscribe": parts.join(", ") };
  // One-click only makes sense when there's an http(s) endpoint to POST to.
  if (url) headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  return headers;
}

// Append a visible unsubscribe footer to the rendered body. `sender` labels who
// the mail is from (COMPLIANCE_FROM_NAME or BREVO_SENDER_NAME).
export function appendUnsubscribeFooter(html, text, email, extra = {}) {
  const url = unsubscribeUrl(email, extra);
  const mailto = unsubscribeMailto();
  const sender =
    process.env.COMPLIANCE_FROM_NAME ||
    process.env.BREVO_SENDER_NAME ||
    "us";
  const address = process.env.COMPLIANCE_ADDRESS || "";

  const link = url || (mailto ? mailto : "");
  const linkLabel = url ? url : "reply with 'unsubscribe'";

  const htmlFooter =
    `\n<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0" />\n` +
    `<p style="color:#94a3b8;font-size:12px;line-height:1.5;margin:0">` +
    `You're receiving this from ${escapeHtml(sender)}.` +
    (link
      ? ` <a href="${escapeHtml(link)}" style="color:#94a3b8">Unsubscribe</a>.`
      : ` To stop, reply with "unsubscribe".`) +
    (address ? `<br/>${escapeHtml(address)}` : "") +
    `</p>`;

  const textFooter =
    `\n\n—\nYou're receiving this from ${sender}.\n` +
    (url ? `Unsubscribe: ${url}\n` : `To stop, reply with "unsubscribe".\n`) +
    (address ? `${address}\n` : "");

  return {
    html: html ? html + htmlFooter : html,
    text: text ? text + textFooter : text,
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
