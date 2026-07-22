// The "AI writes the emails" step (Task 2). Two entry points:
//   • generateSequence — draft a multi-step sequence for a SEGMENT (review then
//     save as templates); used by the Campaigns "AI composer".
//   • generateEmail — write ONE email tailored to a SPECIFIC contact (their real
//     name/company/title), anchored to a reusable campaign brief; used at send
//     time by /api/generate-send so a "Send" click produces a unique email.
//
// Provider-agnostic: delegates the actual model call to src/lib/llm.js, which
// uses OpenAI (OPENAI_API_KEY) or Claude (ANTHROPIC_API_KEY) with structured
// outputs so the response is always valid JSON in our shape. This module owns
// the schemas and the copywriting prompts.

import { chatJSON } from "./llm.js";

// Shared writing rules for every email the model produces.
const RULES = `Rules for every email:
- 60–120 words. One clear, low-friction call to action (a question or a soft ask for a quick chat). Never pushy.
- Plain, specific language. No hype, no "I hope this finds you well", no ALL-CAPS, no exclamation spam, no fake urgency — these trigger spam filters and erode trust.
- Subject lines: short (2–6 words), value or curiosity, never clickbait or "RE:" tricks.
- Do NOT include a signature block, unsubscribe line, or physical address — those are added automatically by the system.`;

// ---- Sequence generation (per-segment, review-then-save) ------------------

const SEQUENCE_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: { subject: { type: "string" }, body: { type: "string" } },
        required: ["subject", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["steps"],
  additionalProperties: false,
};

export async function generateSequence({ productPitch, targetDescription, tone, steps = 3, senderName }) {
  if (!productPitch || !productPitch.trim()) {
    return { error: "A product pitch is required to generate emails." };
  }
  const n = Math.min(Math.max(parseInt(steps, 10) || 3, 1), 5);
  const system = `You are an expert B2B cold-email copywriter. You write short, human, non-spammy outreach sequences that get replies.
${RULES}
- Personalize using the tokens {{first_name}} and {{company}} — greeting uses {{first_name}}, and reference {{company}} naturally. Use them literally; invent no other tokens.
- The sequence is ordered: step 1 is the initial cold email; each later step is a SHORTER follow-up that adds a new angle and lightly references the prior email — never guilt-trip.
Return ONLY the structured object.`;
  const user = [
    `Write a ${n}-step cold-email sequence.`,
    ``,
    `PRODUCT / WHAT WE SELL:`,
    productPitch.trim().slice(0, 4000),
    ``,
    `TARGET RECIPIENT (segment): ${targetDescription?.trim() || "business decision-makers"}`,
    `TONE: ${tone?.trim() || "warm, concise, professional"}`,
    senderName?.trim() ? `FROM: ${senderName.trim()}` : ``,
    ``,
    `Produce exactly ${n} email step(s), in order.`,
  ].filter(Boolean).join("\n");

  const r = await chatJSON({ system, user, schema: SEQUENCE_SCHEMA, schemaName: "email_sequence", kind: "gen" });
  if (r.error) return { error: r.error };
  const out = Array.isArray(r.value?.steps)
    ? r.value.steps.filter((s) => s?.subject && s?.body).map((s) => ({ subject: String(s.subject), body: String(s.body) }))
    : [];
  if (out.length === 0) return { error: "The model returned no usable emails. Try again." };
  return { steps: out };
}

// ---- Single-email generation (per-contact, at send time) ------------------

const EMAIL_SCHEMA = {
  type: "object",
  properties: { subject: { type: "string" }, body: { type: "string" } },
  required: ["subject", "body"],
  additionalProperties: false,
};

/**
 * Write one email tailored to a specific contact, anchored to a campaign brief.
 * @param {object} args
 * @param {string} args.productPitch  what we sell (required)
 * @param {string} [args.theme]       campaign theme / tagline (e.g. "Open Happiness")
 * @param {string} [args.tone]
 * @param {object} args.contact       { name, title, company }
 * @returns {Promise<{subject?, body?, error?}>}
 */
export async function generateEmail({ productPitch, theme, tone, contact }) {
  if (!productPitch || !productPitch.trim()) {
    return { error: "A campaign pitch is required." };
  }
  const c = contact || {};
  const firstName = (c.name || "").trim().split(/\s+/)[0] || "there";

  const system = `You are an expert B2B cold-email copywriter running ONE specific campaign. You write a single email tailored to a specific person.
${RULES}
- This is one campaign with a consistent message/theme — weave the theme in naturally (don't quote it like a slogan unless it fits).
- Personalize to THIS person using the real values provided: address them by first name, and speak to what someone in their role at their company actually cares about. Reference their company by name where natural. Write the real values directly — do NOT output {{tokens}}.
Return ONLY the structured object (subject + body).`;

  const user = [
    `CAMPAIGN — what we sell:`,
    productPitch.trim().slice(0, 4000),
    theme?.trim() ? `\nCAMPAIGN THEME / TAGLINE: ${theme.trim()}` : ``,
    `TONE: ${tone?.trim() || "warm, concise, professional"}`,
    ``,
    `RECIPIENT:`,
    `- First name: ${firstName}`,
    `- Title/role: ${c.title?.trim() || "(unknown)"}`,
    `- Company: ${c.company?.trim() || "(unknown)"}`,
    ``,
    `Write one email tailored to this person.`,
  ].filter(Boolean).join("\n");

  const r = await chatJSON({ system, user, schema: EMAIL_SCHEMA, schemaName: "email", maxTokens: 1200, kind: "gen" });
  if (r.error) return { error: r.error };
  if (!r.value?.subject || !r.value?.body) return { error: "The model returned an empty email. Try again." };
  return { subject: String(r.value.subject), body: String(r.value.body) };
}

// ---- Brief from website text (so the user never writes a brief) -----------

const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    pitch: { type: "string" },
    theme: { type: "string" },
  },
  required: ["pitch", "theme"],
  additionalProperties: false,
};

/**
 * Turn a company website's text into a reusable campaign brief.
 * @returns {Promise<{pitch?, theme?, error?}>}
 */
export async function generateBriefFromText({ siteText }) {
  if (!siteText || !siteText.trim()) return { error: "No website text to read." };
  const system = `You are a B2B marketing analyst. From a company's website text, produce a reusable cold-email campaign brief:
- "pitch": 2–4 plain sentences describing what the company sells and its core value proposition for prospects. Base it ONLY on the provided text — do not invent facts, metrics, or customers.
- "theme": a short campaign tagline (2–5 words) capturing the core promise.
Return ONLY the structured object.`;
  const user = `Company website text:\n${siteText.trim().slice(0, 12000)}`;

  const r = await chatJSON({ system, user, schema: BRIEF_SCHEMA, schemaName: "campaign_brief", maxTokens: 600, kind: "gen" });
  if (r.error) return { error: r.error };
  if (!r.value?.pitch) return { error: "Couldn't derive a brief from that page. Try a different URL." };
  return { pitch: String(r.value.pitch), theme: String(r.value.theme || "") };
}
