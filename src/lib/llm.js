// "Give me valid JSON in this schema", via OpenAI.
//
// Anthropic support was removed on 2026-08-03. The project has only ever run on
// OpenAI — every logged row in email_testing is provider=openai — the Anthropic
// account had no API credit, and a second provider branch that nothing exercises
// is a branch that silently rots. It is in git history if that changes.
//
// No SDK (matching src/lib/brevo.js): a raw fetch using OpenAI structured outputs,
// so the response is always valid JSON.
//
// Models per task ("gen" = writing, "classify" = reply labelling), each
// overridable by env:
//   OPENAI_GEN_MODEL / OPENAI_MODEL   (default gpt-4o / gpt-4o-mini)

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

const OPENAI_DEFAULT = { gen: "gpt-4o", classify: "gpt-4o-mini" };

// Every call's usage lands here so a caller can total the tokens for a whole
// chain without threading a counter through six modules. Reset per run.
let tokenLedger = [];
export function resetTokenLedger() { tokenLedger = []; }
export function tokenLedgerTotals() {
  const t = { calls: 0, input: 0, output: 0, cached_input: 0, by_model: {} };
  for (const e of tokenLedger) {
    t.calls++; t.input += e.input; t.output += e.output; t.cached_input += e.cached_input || 0;
    const m = (t.by_model[e.model] ||= { calls: 0, input: 0, output: 0 });
    m.calls++; m.input += e.input; m.output += e.output;
  }
  return { ...t, calls_detail: tokenLedger.slice() };
}

/** "openai" when a key is present, else null. */
export function aiProvider() {
  return process.env.OPENAI_API_KEY ? "openai" : null;
}

export function aiEnabled() {
  return aiProvider() !== null;
}

/** The model that will actually run, recorded on every email_testing row. */
export function aiModel(kind = "gen") {
  if (!aiProvider()) return null;
  return kind === "gen"
    ? process.env.OPENAI_GEN_MODEL || OPENAI_DEFAULT.gen
    : process.env.OPENAI_MODEL || OPENAI_DEFAULT.classify;
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
  if (!aiProvider()) {
    return { error: "No AI key set. Add OPENAI_API_KEY to .env." };
  }
  return openaiJSON({ system, user, schema, schemaName, maxTokens, kind });
}

async function openaiJSON({ system, user, schema, schemaName, maxTokens, kind }) {
  const model = aiModel(kind);
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
    // Record what this call actually cost before anything can throw.
    const u = data?.usage || {};
    tokenLedger.push({
      model,
      kind,
      input: u.prompt_tokens || 0,
      output: u.completion_tokens || 0,
      cached_input: u.prompt_tokens_details?.cached_tokens || 0,
    });

    const choice = data?.choices?.[0];
    if (choice?.message?.refusal) return { error: "The model declined this request. Try rephrasing." };
    if (choice?.finish_reason === "length") return { error: "Output was truncated — raise maxTokens." };
    try {
      return { value: JSON.parse(choice?.message?.content || "") };
    } catch {
      return { error: "Could not parse the generated content. Try again." };
    }
  } catch (e) {
    return { error: e.message || "Network error calling OpenAI." };
  }
}
