// Turn a plain-text body (what the composer textarea and template bodies store)
// into simple, email-safe HTML: blank lines become <p>, single newlines <br>.
// Shared by the recipients page and the automation worker so a scheduled send
// looks identical to a manual one.
export function htmlFromBody(text) {
  const escaped = String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1d21">${paragraphs}</div>`;
}
