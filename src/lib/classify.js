// The ONE place AI runs for replies: label an inbound reply so the engine knows
// whether to stop, pause, or flag the contact. Everything the label triggers is
// plain code (see worker/reply-scan.mjs) — the model only classifies.
//
// Provider-agnostic via src/lib/llm.js — uses OpenAI (OPENAI_API_KEY) or Claude
// (ANTHROPIC_API_KEY), whichever is configured, with structured outputs. If no
// key is set, classifyReply returns null and the caller falls back to the crude
// "any reply -> stop" rule.

import { chatJSON } from "./llm.js";

export const LABELS = [
  "interested",
  "not_interested",
  "out_of_office",
  "unsubscribe",
  "other",
];

const SCHEMA = {
  type: "object",
  properties: { label: { type: "string", enum: LABELS } },
  required: ["label"],
  additionalProperties: false,
};

const SYSTEM = `You classify a single inbound email reply to a cold sales/outreach email into exactly one label.
- interested: wants to talk, asks for a call/info/pricing, positive engagement.
- not_interested: declines, "no thanks", "not a fit", "we already have a vendor".
- out_of_office: an automatic away/vacation/parental-leave auto-reply.
- unsubscribe: asks to be removed, "stop emailing me", "take me off your list".
- other: bounce notices, unrelated, or anything you can't confidently place.`;

/**
 * @returns {Promise<null | {label: string}>} null when AI is unavailable/failed.
 */
export async function classifyReply({ subject, body }) {
  const user = `Subject: ${subject || "(none)"}\n\nBody:\n${(body || "").slice(0, 6000)}`;
  const r = await chatJSON({
    system: SYSTEM,
    user,
    schema: SCHEMA,
    schemaName: "reply_label",
    maxTokens: 50,
    kind: "classify",
  });
  if (r.error) return null; // no key / failure → caller does "any reply -> stop"
  const label = r.value?.label;
  return LABELS.includes(label) ? { label } : null;
}
