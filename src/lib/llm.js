// Provider-agnostic "give me valid JSON in this schema" call. Uses OpenAI when
// OPENAI_API_KEY is set, otherwise Anthropic (Claude) when ANTHROPIC_API_KEY is
// set. Same { system, user, schema } in → { value } | { error } out, so the
// callers (classify.js, generateSequence.js) don't care which provider runs.
//
// No SDK (matching src/lib/brevo.js): a raw fetch to each provider's API, using
// each one's structured-output feature so the response is always valid JSON.
//
// Model defaults per provider + task ("gen" = email writing, "classify" = reply
// labeling), each overridable by env:
//   OpenAI:    OPENAI_GEN_MODEL / OPENAI_MODEL        (default gpt-4o / gpt-4o-mini)
//   Anthropic: ANTHROPIC_GEN_MODEL / ANTHROPIC_MODEL  (default Opus 4.8 / Haiku 4.5)

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";

const OPENAI_DEFAULT = { gen: "gpt-4o", classify: "gpt-4o-mini" };
const ANTHROPIC_DEFAULT = { gen: "claude-opus-4-8", classify: "claude-haiku-4-5-20251001" };

// OpenAI takes precedence when both keys are present.
export function aiProvider() {
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

export function aiEnabled() {
  return aiProvider() !== null;
}

/**
 * @param {object} a
 * @param {string} a.system     system prompt
 * @param {string} a.user       user message
 * @param {object} a.schema     JSON Schema (objects need additionalProperties:false + full `required`)
 * @param {string} [a.schemaName]
 * @param {number} [a.maxTokens]
 * @param {"gen"|"classify"} [a.kind]
 * @returns {Promise<{value?: any, error?: string}>}
 */
export async function chatJSON({ system, user, schema, schemaName = "result", maxTokens = 4000, kind = "gen" }) {
  const provider = aiProvider();
  if (!provider) {
    return { error: "No AI key set. Add OPENAI_API_KEY (or ANTHROPIC_API_KEY) to .env." };
  }
  return provider === "openai"
    ? openaiJSON({ system, user, schema, schemaName, maxTokens, kind })
    : anthropicJSON({ system, user, schema, maxTokens, kind });
}

async function openaiJSON({ system, user, schema, schemaName, maxTokens, kind }) {
  const model = kind === "gen"
    ? process.env.OPENAI_GEN_MODEL || OPENAI_DEFAULT.gen
    : process.env.OPENAI_MODEL || OPENAI_DEFAULT.classify;
  try {
    const res = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_completion_tokens: maxTokens,
        // OpenAI structured outputs: strict schema, always-valid JSON.
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, strict: true, schema },
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data?.error?.message || `OpenAI returned HTTP ${res.status}` };
    const choice = data?.choices?.[0];
    if (choice?.message?.refusal) return { error: "The model declined this request. Try rephrasing." };
    if (choice?.finish_reason === "length") return { error: "Output was truncated — try fewer steps." };
    try {
      return { value: JSON.parse(choice?.message?.content || "") };
    } catch {
      return { error: "Could not parse the generated content. Try again." };
    }
  } catch (e) {
    return { error: e.message || "Network error calling OpenAI." };
  }
}

async function anthropicJSON({ system, user, schema, maxTokens, kind }) {
  const model = kind === "gen"
    ? process.env.ANTHROPIC_GEN_MODEL || ANTHROPIC_DEFAULT.gen
    : process.env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT.classify;
  try {
    const res = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: { type: "json_schema", schema } },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data?.error?.message || `Anthropic returned HTTP ${res.status}` };
    if (data.stop_reason === "refusal") return { error: "The model declined this request. Try rephrasing." };
    const text = (data?.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    try {
      return { value: JSON.parse(text) };
    } catch {
      return { error: "Could not parse the generated content. Try again." };
    }
  } catch (e) {
    return { error: e.message || "Network error calling Anthropic." };
  }
}
