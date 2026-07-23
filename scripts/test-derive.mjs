// Unit tests for derive() — the routing rules in EMAIL_GENERATION_CONTEXT.md §3.
// Pure functions, no DB and no network, so this runs in milliseconds.
//
//   npm run test:derive
//
// These rules decide which of five templates each institution gets. If they
// drift, every email drifts with them, silently. That is why they are tested
// and the prompt is not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { derive, buildContract, isCitable } from "../src/lib/derive.js";

// Minimal row that clears every Tier 0 gate; override per test.
const base = (over = {}) => ({
  institution_name: "Test Institute",
  is_valid_buyer: true,
  institution_type: "affiliated_college",
  program_mix: "engineering",
  contact_name: "Dr. A. Sharma",
  contact_title: "Training & Placement Officer",
  contact_email: "tpo@test.ac.in",
  recent_event: { type: "none_found", summary: null, date: null, source_url: null },
  specificity_anchor: "16,000+ alumni across 40 countries",
  provenance: { specificity_anchor: { confidence: 0.9, source_url: "https://x" } },
  ...over,
});

test("segment: campus_count > 1 wins over every other rule", () => {
  assert.equal(derive(base({ campus_count: 4, institution_type: "iit_nit_iiit" })).derived.segment_template, "group");
});

test("segment: multi_campus_group type also routes to group", () => {
  assert.equal(derive(base({ institution_type: "multi_campus_group" })).derived.segment_template, "group");
});

test("segment: IIT/NIT/IIIT and central universities are elite", () => {
  assert.equal(derive(base({ institution_type: "iit_nit_iiit" })).derived.segment_template, "elite");
  assert.equal(derive(base({ institution_type: "central_university" })).derived.segment_template, "elite");
});

test("segment: NIRF rank <= 100 is elite regardless of type", () => {
  assert.equal(derive(base({ nirf_rank: { rank: 62, category: "Engineering", year: 2025 } })).derived.segment_template, "elite");
  assert.equal(derive(base({ nirf_rank: { rank: 180, category: "Engineering", year: 2025 } })).derived.segment_template, "college");
});

test("segment: non-engineering program mixes get their own template", () => {
  assert.equal(derive(base({ program_mix: "pharmacy" })).derived.segment_template, "non_engineering");
  assert.equal(derive(base({ program_mix: "management" })).derived.segment_template, "non_engineering");
  // engineering and mixed do NOT route here
  assert.equal(derive(base({ program_mix: "mixed" })).derived.segment_template, "college");
});

test("segment: private and deemed universities are private_uni", () => {
  assert.equal(derive(base({ institution_type: "private_university" })).derived.segment_template, "private_uni");
  assert.equal(derive(base({ institution_type: "deemed_university" })).derived.segment_template, "private_uni");
});

test("pain: elite is always ats_rejection", () => {
  assert.equal(derive(base({ institution_type: "iit_nit_iiit", annual_graduating_cohort: 5000 })).derived.pain_hypothesis, "ats_rejection");
});

test("pain: groups and cohorts over 2000 are staff_bandwidth", () => {
  assert.equal(derive(base({ campus_count: 3 })).derived.pain_hypothesis, "staff_bandwidth");
  assert.equal(derive(base({ annual_graduating_cohort: 2500 })).derived.pain_hypothesis, "staff_bandwidth");
  assert.equal(derive(base({ annual_graduating_cohort: 1200 })).derived.pain_hypothesis, "ats_rejection");
});

test("pain: a published rate under 70 is unreported_cohort", () => {
  assert.equal(derive(base({ claimed_placement_rate: { value: 61, year: 2025 } })).derived.pain_hypothesis, "unreported_cohort");
});

test("pain: NAAC grade plus a published report is accreditation_reporting", () => {
  assert.equal(derive(base({ naac_grade: "A++", publishes_placement_report: true })).derived.pain_hypothesis, "accreditation_reporting");
  // NAAC grade alone is not enough
  assert.equal(derive(base({ naac_grade: "A++" })).derived.pain_hypothesis, "ats_rejection");
});

test("offer: groups get a licence call, everyone else the 50-CV audit", () => {
  assert.equal(derive(base({ campus_count: 2 })).derived.offer_variant, "group_licence_call");
  assert.equal(derive(base()).derived.offer_variant, "free_ats_audit_50");
});

test("proof: only substantiated proofs are selectable (honesty note, §7)", () => {
  // ES London / ATS uplift / dream2rank are not substantiated yet, so every
  // segment must fall back to the free audit. This test SHOULD start failing
  // the day a real proof is added to PROOF_AVAILABLE.
  for (const t of ["iit_nit_iiit", "private_university", "affiliated_college"]) {
    assert.equal(derive(base({ institution_type: t })).derived.proof_to_cite, "free_audit_only");
  }
});

test("hook: a dated recent_event beats the anchor", () => {
  const d = derive(base({
    recent_event: { type: "mou_industry", summary: "signed an MOU with Bajaj Auto Foundation", date: "2026-03-14", source_url: "https://n" },
    provenance: { recent_event: { confidence: 0.9 }, specificity_anchor: { confidence: 0.9 } },
  })).derived;
  assert.equal(d.hook_source, "recent_event");
  assert.match(d.hook_sentence, /Bajaj Auto Foundation/);
});

test("hook: falls back to the anchor when no event was found", () => {
  const d = derive(base()).derived;
  assert.equal(d.hook_source, "specificity_anchor");
  assert.match(d.hook_sentence, /16,000\+ alumni/);
});

test("hook: capped at 25 words", () => {
  const d = derive(base({ specificity_anchor: Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ") })).derived;
  assert.equal(d.hook_sentence.split(/\s+/).length, 25);
});

test("hook: a below-floor confidence is no hook, and that blocks the send", () => {
  const r = derive(base({ provenance: { specificity_anchor: { confidence: 0.5 } } }));
  assert.equal(r.derived.hook_sentence, null);
  assert.equal(r.sendable, false);
  assert.match(r.blocked.join(" "), /no hook/);
});

test("gate: a missing contact name blocks the send", () => {
  const r = derive(base({ contact_name: null }));
  assert.equal(r.sendable, false);
  assert.match(r.blocked.join(" "), /contact_name/);
});

test("gate: a non-buyer is blocked with its reason", () => {
  const r = derive(base({ is_valid_buyer: false, invalid_reason: "training company" }));
  assert.equal(r.sendable, false);
  assert.match(r.blocked.join(" "), /training company/);
});

// Band thresholds (<500 s, <1500 m, <4000 l, else xl) are our choice — §3 names
// the bands but not the cut-offs. Change them here and in deriveDealSize together.
test("deal size: banded on cohort times campuses", () => {
  assert.equal(derive(base({ annual_graduating_cohort: 300 })).derived.deal_size_band, "s");
  assert.equal(derive(base({ annual_graduating_cohort: 1200 })).derived.deal_size_band, "m");
  assert.equal(derive(base({ annual_graduating_cohort: 1200, campus_count: 3 })).derived.deal_size_band, "l");
  assert.equal(derive(base({ annual_graduating_cohort: 1200, campus_count: 4 })).derived.deal_size_band, "xl");
  assert.equal(derive(base()).derived.deal_size_band, null, "unknown cohort must not be guessed");
});

test("contract: facts below the confidence floor never reach the generator", () => {
  const facts = base({
    claimed_placement_rate: { value: 92, year: 2025 },
    median_package_lpa: 6.5,
    provenance: {
      specificity_anchor: { confidence: 0.9 },
      claimed_placement_rate: { confidence: 0.55 }, // uncertain -> must be withheld
      median_package_lpa: { confidence: 0.95 },
    },
  });
  const { contract } = buildContract(facts, null);
  assert.equal(contract.research.claimed_placement_rate, undefined, "a 0.55-confidence number must not be citable");
  assert.equal(contract.research.median_package_lpa, 6.5);
  assert.equal(isCitable(facts, "claimed_placement_rate"), false);
});

test("contract: absent keys are dropped, not sent as null", () => {
  const { contract } = buildContract(base(), null);
  assert.ok(!("median_package_lpa" in contract.research));
  assert.ok(!("top_recruiters" in contract.research));
});
