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

// Anything of the shape [Your Name] / [Position] / <name> left in a body. The
// model reaches for these whenever it is unsure who is writing, and one in a
// real send is worse than a clumsy sentence.
const PLACEHOLDER = /\[[^\]\n]{0,40}\]|<[^>\n]{0,40}>|\{\{[^}\n]{0,40}\}\}/;

/**
 * Fail-closed check that the sender is real. Returns null when fine, else why.
 */
export function signatureProblem(body) {
  const text = String(body || "");
  const m = text.match(PLACEHOLDER);
  if (m) return `unfilled placeholder in the body: ${m[0]}`;
  if (!text.includes(SENDER.name)) return `body does not sign off as ${SENDER.name}`;
  return null;
}
