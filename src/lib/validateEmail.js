// validate() — EMAIL_GENERATION_CONTEXT.md §8. Pure code, no LLM, runs on every
// generated email before it is allowed anywhere near a send.
//
// Fail closed. A blocked email costs nothing. A bad one costs the lead.
//
// The gate that matters most is `no_orphan_numbers`: it is the last line of
// defence against a fabricated placement percentage reaching the person whose
// job that number is.

import { CONFIDENCE_FLOOR } from "./extractFacts.js";
import { radiusBlockNumbers } from "./radiusBlock.js";

const BANNED = [
  "revolutionise", "revolutionize", "cutting-edge", "leverage",
  "in today's competitive landscape", "game-changer", "game changer",
  "i hope this email finds you well", "i hope this finds you well",
  "i came across your institution",
];

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "you", "our", "are",
  "has", "have", "had", "was", "were", "will", "would", "their", "they", "them",
  "its", "it's", "but", "not", "who", "which", "what", "when", "where", "been",
  "than", "then", "there", "here", "also", "into", "over", "more", "most", "some",
  "such", "only", "just", "very", "much", "many", "each", "both", "same", "about",
]);

// Fields that are routing keys or prompt instructions rather than quotable facts.
const NON_QUOTABLE = /^(derived\.)?(pain_hypothesis|segment_template|proof_to_cite|offer_variant|deal_size_band|hook_source|hook_source_url)$|^radius_block\.(constraints|posture|audience)/;

const norm = (s) => String(s ?? "").toLowerCase();
const numbersIn = (s) => (String(s ?? "").match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, ""));

function contentWords(s) {
  return new Set(
    norm(s)
      .replace(/[^a-z0-9\s'+]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  );
}

/** Every number reachable anywhere in the contract — these are legitimate to write. */
function allowedNumbers(contract, block) {
  const out = new Set(radiusBlockNumbers(block));
  const walk = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") return Object.values(v).forEach(walk);
    numbersIn(v).forEach((n) => out.add(n));
  };
  walk(contract);
  // A bare year in a season window ("Aug 2026 - Dec 2026") is already covered by
  // the walk. Nothing else is granted for free.
  return out;
}

/** Candidate strings that would prove a field was actually used in the body. */
function evidenceFor(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(evidenceFor);
  if (typeof value === "object") return evidenceFor(value.value ?? value.summary ?? value.rank);
  return [String(value)];
}

function cosine(a, b) {
  const va = {}, vb = {};
  for (const w of norm(a).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean)) va[w] = (va[w] || 0) + 1;
  for (const w of norm(b).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean)) vb[w] = (vb[w] || 0) + 1;
  let dot = 0, ma = 0, mb = 0;
  for (const w in va) { ma += va[w] * va[w]; if (vb[w]) dot += va[w] * vb[w]; }
  for (const w in vb) mb += vb[w] * vb[w];
  return ma && mb ? dot / (Math.sqrt(ma) * Math.sqrt(mb)) : 0;
}

/**
 * Run every gate. Returns per-gate results so a rejection is explainable rather
 * than just "the model was bad".
 *
 * @param {object} a
 * @param {string} a.subject
 * @param {string} a.body
 * @param {string[]} a.factsCited
 * @param {object} a.contract     the §4 contract that produced this email
 * @param {object} a.block        the radius_block used
 * @param {object} [a.facts]      the research_facts row (for confidence lookups)
 * @param {string[]} [a.recentBodies] last ~50 sent bodies, for dedupe
 * @returns {{valid: boolean, gates: object, failed: string[]}}
 */
export function validateEmail({ subject, body, factsCited = [], contract, block, facts, recentBodies = [] }) {
  const gates = {};
  const add = (name, pass, detail) => { gates[name] = { pass: Boolean(pass), detail: detail || null }; };

  const text = String(body || "");
  const research = contract?.research || {};
  const derived = contract?.derived || {};
  const words = text.trim().split(/\s+/).filter(Boolean);

  // 1. no_orphan_numbers — every digit sequence must trace to the input.
  const allowed = allowedNumbers(contract, block);
  const orphans = [...new Set(numbersIn(text))].filter((n) => !allowed.has(n));
  add("no_orphan_numbers", orphans.length === 0,
    orphans.length ? `untraceable number(s): ${orphans.join(", ")}` : null);

  // Does the recipient's name appear? Computed once, because gate 2 and gate 7
  // must agree about it — "Dear Mr Tambi," is Sanjay Tambi being addressed.
  const contactName = research.contact_name || "";
  const surname = contactName.replace(/^(dr|prof|mr|ms|mrs)\.?\s+/i, "").split(/\s+/).pop() || contactName;
  const hasName = Boolean(contactName) &&
    (norm(text).includes(norm(contactName)) || (surname.length > 2 && norm(text).includes(norm(surname))));

  // 2. facts_cited_match — each cited field must exist AND show up in the body.
  // Models cite either a bare name ("contact_name") or a path ("research.contact_name"),
  // so resolve both against the whole contract.
  const lookup = (f) => {
    if (f.includes(".")) {
      return f.split(".").reduce((o, k) => (o == null ? undefined : o[k]), contract);
    }
    return research[f] ?? derived[f] ?? contract?.radius_block?.[f];
  };
  const missingField = [], notInBody = [];
  for (const f of factsCited) {
    const value = lookup(f);
    if (value === undefined) { missingField.push(f); continue; }
    // Routing keys and prompt instructions are inputs the model USES but never
    // QUOTES: "ats_rejection" is a slug, and the PII constraint is an order, not
    // a fact. Demanding they appear literally rejects correct emails. They still
    // have to EXIST, so a hallucinated field name is still caught.
    if (NON_QUOTABLE.test(f)) continue;
    if (/contact_name$/.test(f)) { if (!hasName) notInBody.push(f); continue; }
    const bodyWords = contentWords(text);
    const shown = evidenceFor(value).some((e) => {
      if (e.length <= 2) return false;
      if (norm(text).includes(norm(e))) return true;
      const hits = [...contentWords(e)].filter((w) => bodyWords.has(w));
      // 3+ overlapping content words, or one distinctive token — an institution
      // written as "IIIT Bhagalpur" has plainly been referenced.
      return hits.length >= 3 || hits.some((w) => w.length >= 6);
    });
    if (!shown) notInBody.push(f);
  }
  add("facts_cited_match", missingField.length === 0 && notInBody.length === 0,
    [missingField.length ? `not in input: ${missingField.join(", ")}` : "",
     notInBody.length ? `listed but absent from body: ${notInBody.join(", ")}` : ""].filter(Boolean).join("; ") || null);

  // 3. word_count
  add("word_count", words.length >= 110 && words.length <= 140, `${words.length} words`);

  // 4. banned_phrases (+ any em-dash)
  const hits = BANNED.filter((p) => norm(text).includes(p));
  if (text.includes("—") || text.includes("–")) hits.push("em-dash");
  add("banned_phrases", hits.length === 0, hits.length ? hits.join(", ") : null);

  // 5. hook_present — first sentence overlaps hook_sentence by 3+ content words.
  // A greeting line ("Dear Dr Sharma,") is not the opening line, so skip it.
  const afterGreeting = text.replace(/^\s*(dear|hello|hi)\b[^\n,]*,?\s*/i, "");
  const firstSentence = afterGreeting.split(/(?<=[.!?])\s/)[0] || "";
  const hookWords = contentWords(derived.hook_sentence);
  const firstWords = contentWords(firstSentence);
  const overlap = [...hookWords].filter((w) => firstWords.has(w));
  add("hook_present", overlap.length >= 3,
    `${overlap.length} overlapping content word(s)${overlap.length ? `: ${overlap.slice(0, 5).join(", ")}` : ""}`);

  // 6. single_cta — never two questions, never a link and a reply request together.
  //    NOTE: §8 says "exactly one question mark or one link". Taken literally that
  //    rejects a valid imperative CTA ("Send me 50 CVs...") which has neither, so
  //    this is enforced as AT MOST one of each and never both.
  const questions = (text.match(/\?/g) || []).length;
  const links = (text.match(/https?:\/\/|www\./gi) || []).length;
  add("single_cta", questions <= 1 && links <= 1 && !(questions >= 1 && links >= 1),
    `${questions} question mark(s), ${links} link(s)`);

  // 7. name_present — and never "Dear Sir/Madam".
  const saidSirMadam = /sir\s*\/?\s*(or)?\s*madam/i.test(text);
  add("name_present", hasName && !saidSirMadam,
    !hasName ? `contact_name "${contactName}" not found in body` : saidSirMadam ? 'used "Sir/Madam"' : null);

  // 8. confidence_floor — nothing cited may sit below the floor.
  const shaky = factsCited.filter((f) => {
    const p = facts?.provenance?.[f];
    return p && Number(p.confidence) < CONFIDENCE_FLOOR;
  });
  add("confidence_floor", shaky.length === 0,
    shaky.length ? `below ${CONFIDENCE_FLOOR}: ${shaky.join(", ")}` : null);

  // 9. dedupe — if this starts firing, the hook fields are too thin and the fix
  //    belongs in extraction, not in the generation prompt.
  let worst = 0;
  for (const prev of recentBodies.slice(0, 50)) worst = Math.max(worst, cosine(text, prev));
  add("dedupe", worst < 0.85, `max similarity ${worst.toFixed(2)} vs last ${Math.min(recentBodies.length, 50)}`);

  const failed = Object.entries(gates).filter(([, g]) => !g.pass).map(([n]) => n);
  return { valid: failed.length === 0, gates, failed };
}
