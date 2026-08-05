// The "AI writes the emails" step (Task 2). Two entry points:
//   • generateSequence — draft a multi-step sequence for a SEGMENT (review then
//     save as templates); used by the Campaigns "AI composer" via /api/generate.
//   • generateResearchNotes — summarise a prospect's own website into short
//     research notes; used by `npm run research:companies`.
//
// Provider-agnostic: delegates the actual model call to src/lib/llm.js, which
// uses OpenAI (OPENAI_API_KEY) with structured
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

// ---- Company research (what "research_done" actually means) ---------------

const RESEARCH_SCHEMA = {
  type: "object",
  properties: { notes: { type: "string" } },
  required: ["notes"],
  additionalProperties: false,
};

/**
 * Summarise a prospect company's own website into short research notes you can
 * use to personalise outreach. Strictly grounded in the fetched page text.
 * @returns {Promise<{notes?: string, error?: string}>}
 */
export async function generateResearchNotes({ company, siteText }) {
  if (!siteText || !siteText.trim()) return { error: "No website text to read." };

  const system = `You are a B2B sales researcher. From a prospect organisation's own website text, write SHORT research notes (3–5 bullet lines, plain text, no markdown headers) that would help someone personalise outreach to them.
Cover only what the text supports: what the institution is, its focus/strengths, anything about placements/careers/industry links, and any hook worth referencing in an email.
Base it ONLY on the provided text — never invent facts, numbers, rankings or names. If the page is thin, say so briefly rather than padding.`;
  const user = `Organisation: ${company || "(unknown)"}\n\nWebsite text:\n${siteText.trim().slice(0, 12000)}`;

  const r = await chatJSON({ system, user, schema: RESEARCH_SCHEMA, schemaName: "research_notes", maxTokens: 700, kind: "gen" });
  if (r.error) return { error: r.error };
  if (!r.value?.notes) return { error: "The model returned no research notes." };
  return { notes: String(r.value.notes) };
}
