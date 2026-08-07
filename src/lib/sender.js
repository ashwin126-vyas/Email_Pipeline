// Who the email is from.
//
// Until now this was nobody: sender_context only reached the contract in
// "on_behalf" mode, so every email in the default mode signed off "[Your Name]"
// — a placeholder that says "generated and never read" louder than any wording
// choice inside the body. The signature is deterministic data, not a judgement
// the model should be making, so it is supplied rather than requested.

export const SENDER = {
  name: process.env.SENDER_NAME || "Aryan Shivahare",
  title: process.env.SENDER_TITLE || "Founder & CEO, RadiusAI",
};

/** The exact sign-off block every generated email must end with. */
export function signature() {
  return `${SENDER.name}\n${SENDER.title}`;
}

/** What the prompts are told, so the model does not invent a sender. */
export function senderBlock(senderContext = "") {
  return {
    name: SENDER.name,
    title: SENDER.title,
    sign_off_exactly: signature(),
    ...(senderContext ? { context: senderContext } : {}),
  };
}

// Anything of the shape [Your Name] / [Position] / {{sender}} left in a body. The
// model reaches for these whenever it is unsure who is writing, and one in a real
// send is worse than a clumsy sentence.
//
// Narrow on purpose. The first version flagged EVERY bracketed run of text, which
// caught a markdown link — "[radiusai.online](https://...)" — and reported it as
// an unfilled placeholder. That is a real defect (the link should be bare) but it
// is a different defect, and mislabelling it sends the retry after the wrong
// thing. So: a bracketed span is a placeholder only when it reads like one.
const PLACEHOLDER_WORDS = /^(your|my|insert|add|enter|name|full name|title|position|designation|role|company|organisation|organization|contact|contact information|email|phone|signature|sender|sign[- ]?off)\b/i;
const TITLE_CASE_ONLY = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}$/;
const TEMPLATE_TOKEN = /\{\{[^}\n]{0,40}\}\}|<\s*(your|name|title|position|sender)[^>\n]{0,30}>/i;

function bracketPlaceholder(text) {
  for (const m of String(text).matchAll(/\[([^\]\n]{0,60})\](\()?/g)) {
    const inner = m[1].trim();
    if (m[2]) continue;                      // "[text](url)" — a markdown link, not a placeholder
    if (!inner) continue;
    if (/^https?:\/\//i.test(inner)) continue;    // a bracketed URL
    if (/^[^\s]+\.[a-z]{2,}$/i.test(inner)) continue; // a bare domain like radiusai.online
    if (PLACEHOLDER_WORDS.test(inner) || TITLE_CASE_ONLY.test(inner)) return m[0];
  }
  return null;
}

/**
 * Fail-closed check that the sender is real. Returns null when fine, else why.
 */
export function signatureProblem(body) {
  const text = String(body || "");
  const bracket = bracketPlaceholder(text);
  if (bracket) return `unfilled placeholder in the body: ${bracket}`;
  const token = text.match(TEMPLATE_TOKEN);
  if (token) return `unfilled placeholder in the body: ${token[0]}`;
  if (!text.includes(SENDER.name)) return `body does not sign off as ${SENDER.name}`;
  return null;
}
