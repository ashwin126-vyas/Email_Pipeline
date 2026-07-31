// synthesize() — RESEARCH_API_FEATURE.md's `synthesis` block. Pure code, no LLM.
//
// Same principle as derive() in the institution pipeline: the model writes prose,
// it does not decide WHICH angle to take. Hook selection is where personalisation
// actually comes from, so it is deterministic, testable and logged rather than
// re-improvised on every request.
//
// The two rules that do the most work here:
//
//   · top_hooks is capped at 3, and the cap is enforced AFTER a near-duplicate
//     pass. Five hooks that are the same fact reworded is one hook, and the spec
//     is right that more facts produce worse emails.
//   · a hook below the citation floor is not a hook. It stays out of top_hooks
//     entirely rather than being handed over with a low score, because the
//     generator's own floor check would drop it anyway and it would only inflate
//     the coverage rating.

import { CITATION_FLOOR } from "./researchPerson.js";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "you", "our", "are",
  "has", "have", "had", "was", "were", "will", "would", "their", "they", "them",
  "its", "but", "not", "who", "which", "what", "when", "where", "been", "than",
  "then", "there", "here", "also", "into", "over", "more", "most", "some", "such",
  "only", "just", "very", "much", "many", "each", "both", "same", "about", "recently",
]);

const MAX_HOOKS = 3;
const MAX_HOOK_WORDS = 25;
// Two hooks sharing this share of their content words are the same hook reworded.
const DUPLICATE_OVERLAP = 0.6;
// Provenance is deduped harder than hooks: two facts this similar are one claim
// in two tenses, but facts (unlike hooks) are meant to cover distinct ground, so
// the bar for collapsing them is higher.
const NEAR_IDENTICAL = 0.8;

const norm = (s) => String(s ?? "").toLowerCase();

function contentWords(s) {
  return new Set(
    norm(s).replace(/[^a-z0-9\s'+-]/g, " ").split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  );
}

function overlapRatio(a, b) {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (!wa.size || !wb.size) return 0;
  let hits = 0;
  for (const w of wa) if (wb.has(w)) hits += 1;
  return hits / Math.min(wa.size, wb.size);
}

function trimWords(s, max) {
  const w = String(s || "").trim().split(/\s+/).filter(Boolean);
  return w.length <= max ? w.join(" ") : w.slice(0, max).join(" ");
}

const isFresh = (date, days = 400) => {
  if (!date) return false;
  const t = new Date(date).getTime();
  return Number.isFinite(t) && Date.now() - t < days * 24 * 3600 * 1000;
};

/**
 * Score one hook. Higher wins.
 *
 * A person-level hook outranks an org-level one at equal confidence: "you
 * published X last month" is a reason to write to YOU, while "your university is
 * ranked N" is a reason to write to two thousand people, and the whole point of
 * the person layer is that it is the part that differs per recipient.
 */
function scoreHook(h) {
  let score = clamp01(h.confidence) * 100;
  if (h.scope === "person") score += 30;
  if (h.is_trigger && isFresh(h.date)) score += 40;
  // A specific detail carries a number or a proper noun; a platitude carries neither.
  if (/\d/.test(h.text || "")) score += 10;
  if (/\b[A-Z][a-z]{2,}/.test(h.text || "")) score += 5;
  if (h.snippet_only) score -= 15;
  return score;
}

const clamp01 = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
};

/** Collect hooks from both levels, tagging each with where it came from. */
function collectHooks({ person, org, target }) {
  const tag = (list, scope) =>
    (list || [])
      .filter((h) => h && h.text)
      .map((h) => ({
        text: trimWords(h.text, MAX_HOOK_WORDS),
        source_url: h.source_url || null,
        confidence: clamp01(h.confidence),
        is_trigger: Boolean(h.is_trigger),
        date: h.date || null,
        snippet_only: Boolean(h.snippet_only),
        scope,
      }));

  return [
    ...tag(person?.hooks, "person"),
    ...tag(target?.hooks, "target"),
    ...tag(org?.hooks, "org"),
  ];
}

/** Rank, drop near-duplicates, cap at 3. Only citable hooks survive. */
export function selectHooks(candidates, { minConfidence = CITATION_FLOOR } = {}) {
  const citable = candidates
    .filter((h) => h.confidence >= minConfidence)
    .sort((a, b) => scoreHook(b) - scoreHook(a));

  const chosen = [];
  for (const h of citable) {
    if (chosen.length >= MAX_HOOKS) break;
    if (chosen.some((c) => overlapRatio(c.text, h.text) >= DUPLICATE_OVERLAP)) continue;
    chosen.push(h);
  }
  return chosen;
}

/** Merge every sourced claim into the spec's flat provenance array. */
export function buildProvenance({ person, org, target }) {
  const out = [];
  const push = (list) => {
    for (const f of list || []) {
      if (!f?.fact) continue;
      out.push({
        fact: String(f.fact).trim(),
        source_url: f.source_url || null,
        confidence: clamp01(f.confidence),
      });
    }
  };

  for (const block of [person, target, org]) {
    if (!block) continue;
    push(block.facts);
    push(block.recent_activity);
    push(block.recent_news);
    push(block.notable_items);
  }

  // Same fact twice: keep the better-sourced copy, not both. Exact-match dedupe
  // is not enough — extraction routinely emits one claim in two tenses ("will
  // coordinate NIMCET 2026" / "is coordinating NIMCET 2026"), and shipping both
  // makes the provenance list look like corroboration when it is one source
  // counted twice.
  const kept = [];
  for (const f of [...out].sort((a, b) => b.confidence - a.confidence)) {
    const dup = kept.find((k) => norm(k.fact) === norm(f.fact) || overlapRatio(k.fact, f.fact) >= NEAR_IDENTICAL);
    if (dup) continue;
    kept.push(f);
  }
  return kept;
}

const SENIOR = /\b(professor|prof|dean|director|principal|chair|chairman|head|vice|provost|rector|registrar|chancellor|chief|cxo|cto|ceo|cfo|coo|vp|president|partner|founder)\b/i;
const JUNIOR = /\b(student|intern|trainee|candidate|graduate|undergrad|scholar|fellow|associate|assistant|junior|analyst)\b/i;

/**
 * formal | peer | warm. Tone is a function of who is being written to, and
 * getting it wrong is expensive in exactly one direction: over-familiarity with a
 * dean reads as a mail merge, while over-formality with a peer merely reads as
 * polite. So ties break toward formal.
 */
export function recommendTone({ mode, person, target, org }) {
  const subject = mode === "on_behalf" ? target : person;
  const title = `${subject?.role || subject?.current_title || ""}`;

  if (mode === "on_behalf") return "formal"; // writing to a stranger on someone's behalf
  if (SENIOR.test(title)) return "formal";
  if (JUNIOR.test(title)) return "warm";
  // The institution check must not depend on research having SUCCEEDED. A real
  // run addressed a TPO at Aligarh Muslim University as a peer purely because
  // coverage came back thin and the org block was empty — but the caller told us
  // the university's name in the request, so we always knew it was academic.
  const orgText = `${org?.type || ""} ${org?.name || ""} ${subject?.current_org || ""} ${subject?.university || ""}`;
  if (/university|college|institute|school|research|vidyalaya|vidyapeeth|academy/i.test(orgText)) {
    return "formal";
  }
  return "peer";
}

/**
 * The reason to write NOW. Only a dated, citable, recent event qualifies — an
 * undated "they do research in AI" is not a trigger, it is a description, and
 * treating it as one produces emails that claim urgency they cannot justify.
 */
export function pickTrigger(hooks, provenance, { minConfidence = CITATION_FLOOR } = {}) {
  const triggers = hooks.filter((h) => h.is_trigger && isFresh(h.date) && h.confidence >= minConfidence);
  if (triggers.length) return triggers.sort((a, b) => scoreHook(b) - scoreHook(a))[0].text;
  return "";
}

/**
 * Common ground. With the org as the shared research unit, the strongest citable
 * org fact IS what every recipient at that university has in common — which is
 * exactly the campaign-level layer the person hooks then vary against.
 */
export function pickSharedContext({ org, senderContext, provenance, minConfidence = CITATION_FLOOR }) {
  const orgFacts = (org?.facts || [])
    .filter((f) => f?.fact && clamp01(f.confidence) >= minConfidence)
    .sort((a, b) => clamp01(b.confidence) - clamp01(a.confidence));
  if (!orgFacts.length) return "";

  // In on_behalf mode, prefer the org fact that actually overlaps what the sender
  // brings — that is the difference between common ground and a fun fact.
  if (senderContext) {
    const ranked = [...orgFacts].sort(
      (a, b) => overlapRatio(b.fact, senderContext) - overlapRatio(a.fact, senderContext)
    );
    if (overlapRatio(ranked[0].fact, senderContext) > 0) return ranked[0].fact;
  }
  return orgFacts[0].fact;
}

/** A short angle for the subject line — not the subject itself, which the model writes. */
export function subjectAngle(topHooks, emailIntent) {
  const raw = topHooks.length ? topHooks[0].text : emailIntent || "";
  // Truncating mid-phrase leaves a dangling "in"/"for"/"and", which reads as a
  // bug in whatever consumes the angle. Drop trailing connectives.
  return trimWords(raw, 8).replace(/[\s,;:]+(?:in|on|at|to|of|for|and|with|the|a|an|by|from)$/i, "").replace(/[\s,;:.]+$/, "");
}

/**
 * fewer than 2 citable hooks => thin, and the caller is expected to short-circuit
 * rather than let the generator fake specificity to fill space.
 */
export function rateCoverage(topHooks, sourcesChecked) {
  if (topHooks.length < 2) return "thin";
  if (topHooks.length >= 3 && sourcesChecked >= 3) return "high";
  return "partial";
}

/**
 * Assemble the full research output. Pure: same inputs, same output, every time.
 *
 * @param {object} a
 * @param {"to_person"|"on_behalf"} a.mode
 * @param {object} a.person   person block from researchPerson()
 * @param {object} a.org      org block from researchOrg()
 * @param {object} [a.target] target block (on_behalf only)
 * @param {number} a.sourcesChecked
 * @param {string} [a.emailIntent]
 * @param {string} [a.senderContext]
 * @param {number} [a.minConfidence]
 * @returns {object} the RESEARCH_API_FEATURE.md output schema
 */
export function synthesize({
  mode = "to_person",
  person,
  org,
  target,
  sourcesChecked = 0,
  emailIntent = "",
  senderContext = "",
  minConfidence = CITATION_FLOOR,
}) {
  const provenance = buildProvenance({ person, org, target });
  const top_hooks = selectHooks(collectHooks({ person, org, target }), { minConfidence });
  const coverage = rateCoverage(top_hooks, sourcesChecked);

  const output = {
    person: {
      full_name: person?.full_name || "",
      email: person?.email || "",
      current_title: person?.current_title || "",
      current_org: person?.current_org || "",
      university: person?.university || "",
      program_or_degree: person?.program_or_degree || "",
      grad_year: person?.grad_year || "",
      location: person?.location || "",
      linkedin_url: person?.linkedin_url || "",
      linkedin_headline: person?.linkedin_headline || "",
      linkedin_about: person?.linkedin_about || "",
      recent_activity: (person?.recent_activity || []).map((f) => f.fact).filter(Boolean),
      skills_interests: person?.skills_interests || [],
      notable_items: (person?.notable_items || []).map((f) => f.fact).filter(Boolean),
    },

    university: {
      name: org?.name || "",
      location: org?.location || "",
      type: org?.type || "",
      relevant_department: org?.relevant_department || "",
      ranking_notes: org?.ranking_notes || "",
      recent_news: (org?.recent_news || []).map((f) => f.fact).filter(Boolean),
      key_urls: org?.key_urls || [],
    },

    synthesis: {
      top_hooks: top_hooks.map((h) => h.text),
      trigger_event: pickTrigger(top_hooks, provenance, { minConfidence }),
      shared_context: pickSharedContext({ org, senderContext, provenance, minConfidence }),
      suggested_subject_angle: subjectAngle(top_hooks, emailIntent),
      recommended_tone: recommendTone({ mode, person, target, org }),
    },

    provenance,

    meta: {
      researched_at: new Date().toISOString(),
      sources_checked: sourcesChecked,
      coverage,
    },
  };

  if (mode === "on_behalf") {
    output.target = {
      name: target?.full_name || target?.name || "",
      role: target?.role || target?.current_title || "",
      org: target?.current_org || target?.org || "",
      linkedin_url: target?.linkedin_url || "",
      notable_items: (target?.notable_items || []).map((f) => f.fact).filter(Boolean),
    };
  }

  // Kept alongside the spec's public shape: which hook came from where, so a
  // reviewer can tell a person-specific angle from a campaign-wide one.
  output.meta.hook_sources = top_hooks.map((h) => ({
    text: h.text,
    scope: h.scope,
    source_url: h.source_url,
    confidence: h.confidence,
    snippet_only: Boolean(h.snippet_only),
  }));

  return output;
}
