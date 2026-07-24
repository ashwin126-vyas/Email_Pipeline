// Unit tests for the research-quality guards.
//
//   npm run test:research
//
// Each of these encodes a defect found in the real data. They are regression
// tests for mistakes that were actually made, not hypothetical ones.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isPersonName, nameProblem, displayName } from "../src/lib/personName.js";
import { enforceSourcing } from "../src/lib/extractFacts.js";

const URLS = new Set(["https://x.ac.in/placement", "https://x.ac.in/about"]);
const facts = (over = {}) => ({
  institution_name: "X College of Engineering",
  specificity_anchor: "16,000+ alumni across 40 countries",
  recent_event: { type: "none_found", summary: null, date: null, source_url: null },
  provenance: {},
  ...over,
});

// ── personName ─────────────────────────────────────────────────────────────

test("personName: real names pass", () => {
  for (const n of ["Sanjay Tambi", "Dr. A. Sharma", "Kamepalli Ramanjaneyulu", "Prerna Akhouri"]) {
    assert.equal(isPersonName(n), true, `${n} should be a person`);
  }
});

test("personName: shared mailboxes title-cased by Apollo are rejected", () => {
  // Every one of these is in the live contacts table.
  for (const n of ["Placement Ssce", "Training Cell", "Tpo Shegaon", "Tpo Institutes", "Srkr Relations", "Training Jhansi"]) {
    assert.equal(isPersonName(n), false, `${n} is a mailbox, not a person`);
  }
});

test("personName: a single word is not enough to address someone", () => {
  assert.equal(isPersonName("Mayank"), false);
  assert.match(nameProblem("Mayank"), /single word/);
});

test("personName: blanks and honorific-only are rejected", () => {
  assert.equal(isPersonName(""), false);
  assert.equal(isPersonName("Dr."), false);
});

test("personName: strips honorifics for salutation", () => {
  assert.equal(displayName("Dr. Sanjay Tambi"), "Sanjay Tambi");
});

// ── enforceSourcing ────────────────────────────────────────────────────────

test("sourcing: a citable fact with no source_url is demoted below the floor", () => {
  const f = facts({ provenance: { specificity_anchor: { confidence: 0.9, source_url: null } } });
  const r = enforceSourcing(f, URLS);
  assert.equal(f.provenance.specificity_anchor.confidence, 0.5);
  assert.equal(f.provenance.specificity_anchor.unsourced, true);
  assert.deepEqual(r.demoted, ["specificity_anchor"]);
});

test("sourcing: a source_url we never fetched is not a source", () => {
  const f = facts({ provenance: { naac_grade: { confidence: 0.95, source_url: "https://invented.example/page" } } });
  enforceSourcing(f, URLS);
  assert.equal(f.provenance.naac_grade.confidence, 0.5, "an unverifiable URL must not confer citability");
});

test("sourcing: a properly sourced fact is left alone", () => {
  const f = facts({ provenance: { naac_grade: { confidence: 0.9, source_url: "https://x.ac.in/about" } } });
  const r = enforceSourcing(f, URLS);
  assert.equal(f.provenance.naac_grade.confidence, 0.9);
  assert.deepEqual(r.demoted, []);
});

test("sourcing: routing fields do not need a source", () => {
  const f = facts({ provenance: { institution_type: { confidence: 0.9, source_url: null } } });
  const r = enforceSourcing(f, URLS);
  assert.equal(f.provenance.institution_type.confidence, 0.9);
  assert.deepEqual(r.demoted, []);
});

test("event: an undated event is not an event", () => {
  const f = facts({
    recent_event: { type: "mou_industry", summary: "signed an MOU", date: null, source_url: "https://x.ac.in/about" },
  });
  const r = enforceSourcing(f, URLS);
  assert.equal(f.recent_event.type, "none_found");
  assert.equal(r.event_dropped, "no date");
});

test("event: an unsourced event is dropped", () => {
  const f = facts({
    recent_event: { type: "mou_industry", summary: "signed an MOU", date: "2026-05-01", source_url: null },
  });
  assert.equal(enforceSourcing(f, URLS).event_dropped, "unsourced");
});

test("event: an event older than 12 months is dropped", () => {
  const f = facts({
    recent_event: { type: "mou_industry", summary: "signed an MOU", date: "2019-01-01", source_url: "https://x.ac.in/about" },
  });
  assert.match(enforceSourcing(f, URLS).event_dropped, /older/);
});

test("event: a dated, sourced, recent event survives", () => {
  const recent = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const f = facts({
    recent_event: { type: "mou_industry", summary: "signed an MOU", date: recent, source_url: "https://x.ac.in/about" },
  });
  const r = enforceSourcing(f, URLS);
  assert.equal(f.recent_event.type, "mou_industry");
  assert.equal(r.event_dropped, null);
});

test("placement rate: a single-department row is rejected (the Gardi 100% case)", () => {
  // CIVIL: 2 registered, 2 placed, 100%. Quoting this back is a lead-killer.
  const f = facts({
    claimed_placement_rate: { value: 100, year: 2026, basis: "single_department", cohort_size: 2, source_url: "https://x.ac.in/placement", confidence: 0.9 },
  });
  const r = enforceSourcing(f, URLS);
  assert.equal(f.claimed_placement_rate, null);
  assert.match(r.rate_rejected, /single_department/);
});

test("placement rate: 100% over a tiny or unstated cohort is rejected", () => {
  const f = facts({
    claimed_placement_rate: { value: 100, year: 2026, basis: "institution_wide", cohort_size: null, source_url: "https://x.ac.in/placement", confidence: 0.9 },
  });
  assert.match(enforceSourcing(f, URLS).rate_rejected, /tiny|unstated/);
});

test("placement rate: an institution-wide figure over a real cohort survives", () => {
  const f = facts({
    claimed_placement_rate: { value: 87, year: 2025, basis: "institution_wide", cohort_size: 1400, source_url: "https://x.ac.in/placement", confidence: 0.9 },
  });
  const r = enforceSourcing(f, URLS);
  assert.equal(f.claimed_placement_rate.value, 87);
  assert.equal(r.rate_rejected, undefined);
});

test("placement rate: an impossible percentage is rejected", () => {
  const f = facts({
    claimed_placement_rate: { value: 140, year: 2025, basis: "institution_wide", cohort_size: 900, source_url: "https://x.ac.in/placement", confidence: 0.9 },
  });
  assert.match(enforceSourcing(f, URLS).rate_rejected, /range/);
});

test("anchor: affiliation boilerplate is not a specificity anchor", () => {
  const f = facts({ specificity_anchor: "B.H. Gardi College of Engineering is affiliated to GTU." });
  const r = enforceSourcing(f, URLS);
  assert.equal(f.specificity_anchor, null);
  assert.match(r.anchor_rejected, /generic/);
});

test("anchor: a genuinely distinctive anchor survives", () => {
  const f = facts();
  const r = enforceSourcing(f, URLS);
  assert.equal(f.specificity_anchor, "16,000+ alumni across 40 countries");
  assert.equal(r.anchor_rejected, undefined);
});

test("sibling: a homoeopathy accreditation is not an engineering college's", () => {
  // The real defect: B.H. Gardi College of ENGINEERING was given the trust's
  // homoeopathy college's A+ QCI accreditation as its hook.
  const f = facts({
    institution_name: "B H Gardi College of Engineering & Technology",
    is_multi_institution_trust: true,
    sibling_institutions: ["Homoeopathy College", "Institute of Nursing"],
    specificity_anchor: "A+ accreditation by the Quality Council of India for its homoeopathy college",
    provenance: { specificity_anchor: { confidence: 0.9, source_url: "https://x.ac.in/about" } },
  });
  const r = enforceSourcing(f, URLS);
  assert.equal(f.specificity_anchor, null);
  assert.equal(r.sibling_conflicts.length, 1);
});

test("sibling: a homoeopathy college may keep its own homoeopathy facts", () => {
  const f = facts({
    institution_name: "Shri Gardi Homoeopathy College",
    is_multi_institution_trust: true,
    sibling_institutions: ["College of Engineering"],
    specificity_anchor: "A+ accreditation by the Quality Council of India for its homoeopathy college",
    provenance: { specificity_anchor: { confidence: 0.9, source_url: "https://x.ac.in/about" } },
  });
  const r = enforceSourcing(f, URLS);
  assert.equal(f.specificity_anchor, "A+ accreditation by the Quality Council of India for its homoeopathy college");
  assert.deepEqual(r.sibling_conflicts, []);
});
