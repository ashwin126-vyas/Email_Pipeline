// Unit tests for validate() — the gates in EMAIL_GENERATION_CONTEXT.md §8.
//
//   npm run test:validate
//
// These gates are the last thing standing between a hallucinated placement
// percentage and the TPO who owns that number. They are tested against the
// failure modes actually observed in generation, not invented ones.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEmail } from "../src/lib/validateEmail.js";

const contract = {
  research: {
    institution_name: "Poornima University",
    contact_name: "Saloni Jain",
    placement_cell_name: "Training & Placement Cell",
  },
  derived: {
    hook_sentence: "16,000+ alumni across 40 countries",
    pain_hypothesis: "ats_rejection",
    offer_variant: "free_ats_audit_50",
  },
  radius_block: {
    offer: "Send me 50 CVs from your most recent batch and I will return a named report.",
    constraints: { pii: "Student CVs are deleted after the audit." },
  },
};
const block = contract.radius_block;

// A body that passes every gate; each test bends exactly one thing.
const goodBody = [
  "Dear Saloni Jain,",
  "",
  "With 16,000 alumni across 40 countries, Poornima University reaches a long way.",
  "Student CVs are often rejected by applicant tracking systems for formatting",
  "reasons before a recruiter ever reads them, which says nothing about the",
  "student. That filtering happens quietly and it is invisible in the placement",
  "numbers your team reports at the end of the season. RadiusAI turns a student's",
  "raw details into a recruiter ready CV that parses cleanly on the other side.",
  "Send me 50 CVs from your most recent batch and I will return a named report",
  "showing which ones fail parsing and why. There is no cost and nothing to sign.",
  "Those CVs would be used only for that audit and deleted afterwards, and I am",
  "happy to keep the whole thing to a single department if that is simpler.",
].join(" ");

const run = (over = {}) =>
  validateEmail({
    subject: "helping poornima grads",
    body: goodBody,
    factsCited: ["research.contact_name", "derived.hook_sentence"],
    contract, block, facts: { provenance: {} }, recentBodies: [],
    ...over,
  });

test("the baseline email passes every gate", () => {
  const r = run();
  assert.equal(r.valid, true, `unexpected failures: ${r.failed.join(", ")}`);
});

test("no_orphan_numbers: a number not in the contract is rejected", () => {
  // 87% appears nowhere in the input — this is the fabricated-statistic case.
  const r = run({ body: goodBody.replace("reaches a long way", "reports an 87% placement rate") });
  assert.equal(r.gates.no_orphan_numbers.pass, false);
  assert.match(r.gates.no_orphan_numbers.detail, /87/);
});

test("no_orphan_numbers: numbers from the contract and the offer are allowed", () => {
  assert.equal(run().gates.no_orphan_numbers.pass, true, "16,000 / 40 / 50 must all be permitted");
});

test("word_count: enforces the 110-140 band", () => {
  assert.equal(run({ body: "Dear Saloni Jain, too short." }).gates.word_count.pass, false);
});

test("banned_phrases: catches an em-dash and the §6 list", () => {
  assert.equal(run({ body: goodBody.replace("way.", "way — really.") }).gates.banned_phrases.pass, false);
  assert.equal(run({ body: goodBody.replace("reaches", "will leverage") }).gates.banned_phrases.pass, false);
});

test("hook_present: a freely rephrased hook fails (the BIT Mesra case)", () => {
  const r = run({ body: goodBody.replace("With 16,000 alumni across 40 countries", "With a long history") });
  assert.equal(r.gates.hook_present.pass, false);
});

test("name_present: a surname-only greeting counts", () => {
  const r = run({ body: goodBody.replace("Dear Saloni Jain,", "Dear Ms. Jain,") });
  assert.equal(r.gates.name_present.pass, true);
});

test("name_present: Sir/Madam is rejected even if the name appears", () => {
  const r = run({ body: goodBody.replace("Dear Saloni Jain,", "Dear Sir/Madam, Saloni Jain") });
  assert.equal(r.gates.name_present.pass, false);
});

test("facts_cited_match: contact_name agrees with the name_present gate", () => {
  // Regression: "Dear Mr Tambi," used to pass name_present but fail this gate.
  const r = run({ body: goodBody.replace("Dear Saloni Jain,", "Dear Ms. Jain,") });
  assert.equal(r.gates.facts_cited_match.pass, true);
  assert.equal(r.gates.name_present.pass, true);
});

test("facts_cited_match: a field that is not in the input is rejected", () => {
  const r = run({ factsCited: ["research.median_package_lpa"] });
  assert.equal(r.gates.facts_cited_match.pass, false);
  assert.match(r.gates.facts_cited_match.detail, /not in input/);
});

test("facts_cited_match: routing slugs need not appear verbatim", () => {
  // "ats_rejection" is a routing key, not a phrase anyone would write.
  const r = run({ factsCited: ["derived.pain_hypothesis", "derived.offer_variant"] });
  assert.equal(r.gates.facts_cited_match.pass, true);
});

test("single_cta: two questions fail, an imperative CTA passes", () => {
  assert.equal(run({ body: goodBody.replace("why.", "why? Interested?") }).gates.single_cta.pass, false);
  assert.equal(run().gates.single_cta.pass, true, "an imperative ask with no question mark is one CTA");
});

test("single_cta: a link plus a question fails", () => {
  const r = run({ body: goodBody.replace("why.", "why? Book at https://cal.example.com") });
  assert.equal(r.gates.single_cta.pass, false);
});

test("confidence_floor: citing a below-floor fact is rejected", () => {
  const r = run({
    factsCited: ["research.contact_name", "claimed_placement_rate"],
    facts: { provenance: { claimed_placement_rate: { confidence: 0.55 } } },
  });
  assert.equal(r.gates.confidence_floor.pass, false);
});

test("dedupe: an identical body fails against recent sends", () => {
  const r = run({ recentBodies: [goodBody] });
  assert.equal(r.gates.dedupe.pass, false);
});

test("dedupe: a different body passes", () => {
  const r = run({ recentBodies: ["Completely unrelated text about quarterly logistics reporting."] });
  assert.equal(r.gates.dedupe.pass, true);
});
