// generate() — LLM call #2 of the outreach pipeline (EMAIL_GENERATION_CONTEXT.md §6).
//
// Input is the §4 contract ONLY: typed facts from research_facts, the derived
// routing from derive(), and the static radius_block. Raw `research_notes` prose
// is never passed here, which is the whole point of splitting extract() from
// generate() — free text in, generic email out.
//
// Everything is written to email_generations: the prompt that was sent, the
// contract it was built from, the content that came back, and how it scored on
// the validation gates. Generating is free and reversible; sending is not.

import { chatJSON, aiProvider } from "./llm.js";
import { buildContract } from "./derive.js";
import { radiusBlock } from "./radiusBlock.js";
import { validateEmail } from "./validateEmail.js";

// Bump when the prompt text changes, so old rows stay attributable.
export const PROMPT_VERSION = "v1-2026-07";

const EMAIL_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Max 6 words, specific to this institution, no colons, no 'Re:'." },
    body: { type: "string", description: "110-140 words." },
    facts_cited: {
      type: "array",
      items: { type: "string" },
      description: "Every input field name you referenced. Checked against the body by code.",
    },
  },
  required: ["subject", "body", "facts_cited"],
  additionalProperties: false,
};

const SYSTEM = `You write one cold outreach email from an early-stage founder to a placement
officer at an Indian institution.

RULES
1. 110 to 140 words in the body. Count them.
2. Begin with a short greeting line addressing the recipient by their name from
   research.contact_name, e.g. "Dear Dr Sharma," on its own line. Then open the
   FIRST SENTENCE of the email with the hook_sentence, rephrased naturally. Never
   open with "I hope this email finds you well", "I came across your institution",
   or any variant. The greeting is not the opening line; the hook is.
3. Line 2 names the pain from pain_hypothesis, framed as an observation about the
   category, not an accusation about them.
4. Cite ONLY facts present in the input. You may not introduce any number,
   percentage, statistic, client name or testimonial that is not in the input.
   If you want a number and do not have one, write the sentence without it.
5. Use placement_cell_name when referring to their team. Use their words.
6. One CTA, taken from the offer in radius_block. Never a calendar link and a
   reply request in the same email. Never two questions.
7. No em-dashes. No exclamation marks. No "revolutionise", "cutting-edge",
   "leverage", "in today's competitive landscape", "game-changer".
8. Subject line: max 6 words, lowercase-ish, specific to this institution, no
   colons, no "Re:", no clickbait.
9. Address the recipient by name. Never "Dear Sir/Madam".
10. Sign off as the founder using the signature block in radius_block. If the
    signature name is empty, end after the CTA and add no sign-off at all.

facts_cited must list every input field you referenced, using its exact dotted
path in the input, e.g. "research.contact_name", "derived.hook_sentence",
"radius_block.offer". It is checked against the body by code. Referencing a field
you did not list, or listing one you did not use, fails validation.`;

/** The exact user message for a contract — exported so it can be stored verbatim. */
export function buildUserPrompt(contract) {
  return `INPUT\n${JSON.stringify(contract, null, 2)}`;
}

/**
 * Pull everything needed for one contact and assemble the §4 contract.
 * Joins research_facts (typed facts) + company_contacts (the real person) +
 * company_campaigns (the tracker row this generation belongs to).
 *
 * NB: company_campaigns.research_notes is deliberately NOT selected into the
 * contract. It is prose, and prose never reaches the generator.
 */
export async function loadContractFor(pool, { contactId }) {
  const { rows } = await pool.query(
    `SELECT cc.id   AS contact_id,
            cc.company_id,
            cc.person, cc.title, cc.email,
            co.name  AS company_name,
            cam.id   AS tracker_id,
            cam.total_employees,
            rf.*
       FROM company_contacts cc
       JOIN companies co            ON co.id  = cc.company_id
       LEFT JOIN company_campaigns cam ON cam.company_id = cc.company_id
       LEFT JOIN research_facts rf  ON rf.company_id = cc.company_id AND rf.is_current
      WHERE cc.id = $1`,
    [contactId]
  );
  if (rows.length === 0) return { error: "No such contact." };
  const r = rows[0];
  if (!r.institution_name && !r.company_id) return { error: "No research_facts for this company." };

  // The person we are actually writing to overrides whoever the facts row named:
  // one company can have several contacts, and each gets their own email.
  const facts = {
    ...r,
    contact_name: r.person || r.contact_name,
    contact_title: r.title || r.contact_title,
    contact_email: r.email || r.contact_email,
    institution_name: r.institution_name || r.company_name,
  };

  const { contract, blocked, sendable } = buildContract(facts, null);
  contract.radius_block = radiusBlock(contract.derived);
  return {
    facts,
    contract,
    blocked,
    sendable,
    meta: {
      companyId: r.company_id,
      contactId: r.contact_id,
      researchFactsId: r.id || null,
      trackerId: r.tracker_id || null,
      company: r.company_name,
      contactName: facts.contact_name,
      contactEmail: facts.contact_email,
    },
  };
}

/**
 * Generate one email from a contract and run every validation gate.
 * @returns {Promise<{subject?, body?, factsCited?, validation?, prompts, error?}>}
 */
export async function generateOutreachEmail({ contract, facts, recentBodies = [], attempts = 2 }) {
  const basePrompt = buildUserPrompt(contract);
  let userPrompt = basePrompt;
  let last = null;

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    const prompts = { system: SYSTEM, user: userPrompt, version: PROMPT_VERSION };
    const r = await chatJSON({
      system: SYSTEM,
      user: userPrompt,
      schema: EMAIL_SCHEMA,
      schemaName: "outreach_email",
      maxTokens: 1200,
      kind: "gen",
    });
    if (r.error) return { prompts, error: r.error, attempts: attempt };
    const v = r.value || {};
    if (!v.subject || !v.body) return { prompts, error: "The model returned an empty email.", attempts: attempt };

    const factsCited = Array.isArray(v.facts_cited) ? v.facts_cited.map(String) : [];
    const validation = validateEmail({
      subject: v.subject, body: v.body, factsCited,
      contract, block: contract.radius_block, facts, recentBodies,
    });

    last = { prompts, subject: String(v.subject), body: String(v.body), factsCited, validation, attempts: attempt };
    if (validation.valid) return last;

    // Retry once with the specific gate failures named. Most rejections are
    // near-misses (107 words, one em-dash) that the model fixes when told.
    // The retry is re-validated from scratch — nothing is waved through.
    const notes = validation.failed
      .map((g) => `- ${g}: ${validation.gates[g].detail || "failed"}`)
      .join("\n");
    userPrompt = `${basePrompt}

A previous attempt was REJECTED by the automated validator for these reasons:
${notes}

Rewrite the email so every one of those is fixed. Keep everything that was fine.
Reminders: the body must be between 110 and 140 words; the first sentence after
the greeting must reuse at least three distinctive words from derived.hook_sentence;
no em-dashes anywhere (use a comma or a full stop).`;
  }
  return last;
}

/** Last N generated bodies, for the dedupe gate. */
export async function recentBodies(pool, limit = 50) {
  const { rows } = await pool.query(
    `SELECT body FROM email_generations
      WHERE body IS NOT NULL AND is_valid
      ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows.map((r) => r.body);
}

/** Persist one generation attempt — success or failure. */
export async function saveGeneration(pool, { meta, contract, prompts, result }) {
  const d = contract?.derived || {};
  const val = result?.validation;
  const { rows } = await pool.query(
    `INSERT INTO email_generations (
       company_id, company_contact_id, research_facts_id,
       company, contact_name, contact_email,
       prompt_system, prompt_user, prompt_version,
       input_contract, segment_template, pain_hypothesis, proof_to_cite,
       offer_variant, hook_sentence,
       subject, body, facts_cited,
       is_valid, validation, status, provider, model, error)
     VALUES ($1,$2,$3, $4,$5,$6, $7,$8,$9, $10,$11,$12,$13,$14,$15,
             $16,$17,$18, $19,$20,$21,$22,$23,$24)
     RETURNING id`,
    [
      meta.companyId, meta.contactId, meta.researchFactsId,
      meta.company, meta.contactName, meta.contactEmail,
      prompts.system, prompts.user, prompts.version,
      JSON.stringify(contract), d.segment_template, d.pain_hypothesis, d.proof_to_cite,
      d.offer_variant, d.hook_sentence,
      result?.subject || null, result?.body || null, result?.factsCited || null,
      Boolean(val?.valid), JSON.stringify(val?.gates || {}),
      result?.error ? "failed" : val?.valid ? "draft" : "rejected",
      aiProvider(), process.env.OPENAI_GEN_MODEL || process.env.ANTHROPIC_GEN_MODEL || null,
      result?.error || null,
    ]
  );
  return rows[0].id;
}
