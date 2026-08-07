// Unit tests for the research API's pure-code layers (RESEARCH_API_FEATURE.md).
//
//   npm run test:person
//
// Everything here runs without a network, a database or an API key: the parts
// under test are exactly the parts that were deliberately kept out of the model's
// hands — sourcing enforcement, hook selection, coverage, and the email gates.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  enforceSourcing, CITATION_FLOOR, SNIPPET_CONFIDENCE_CAP, UNSOURCED_CONFIDENCE,
} from "../src/lib/researchPerson.js";
import {
  selectHooks, rateCoverage, recommendTone, pickTrigger, buildProvenance, synthesize,
} from "../src/lib/synthesize.js";
import { validatePersonEmail, buildEmailContract } from "../src/lib/generatePersonEmail.js";
import { validateCampaign } from "../src/lib/generateCampaign.js";
import { isUnfetchable } from "../src/lib/researchCrawl.js";
import { orgKey, personKey } from "../src/lib/personResearchStore.js";

const FETCHED = "https://nitt.edu/cse";
const SNIPPET = "https://www.linkedin.com/in/someone";
const urls = { fetched: new Set([FETCHED]), snippet: new Set([SNIPPET]) };

const recent = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

// ── sourcing enforcement ───────────────────────────────────────────────────

test("a fact from a page we fetched keeps its confidence", () => {
  const block = { facts: [{ fact: "Heads the CSE department.", source_url: FETCHED, confidence: 0.9 }] };
  enforceSourcing(block, urls);
  assert.equal(block.facts[0].confidence, 0.9);
});

test("a fact seen only in a search snippet is capped below the citation floor", () => {
  const block = { facts: [{ fact: "Promoted to Professor.", source_url: SNIPPET, confidence: 0.95 }] };
  const report = enforceSourcing(block, urls);
  assert.equal(block.facts[0].confidence, SNIPPET_CONFIDENCE_CAP);
  assert.ok(SNIPPET_CONFIDENCE_CAP < CITATION_FLOOR, "snippets must not be citable by default");
  assert.equal(block.facts[0].snippet_only, true);
  assert.equal(report.snippet_capped.length, 1);
});

test("a fact citing a URL we never saw is demoted — confidence without a source is an assertion", () => {
  const block = { facts: [{ fact: "Raised a $2M grant.", source_url: "https://invented.example/news", confidence: 1 }] };
  const report = enforceSourcing(block, urls);
  assert.equal(block.facts[0].confidence, UNSOURCED_CONFIDENCE);
  assert.equal(block.facts[0].unsourced, true);
  assert.equal(report.demoted.length, 1);
});

test("a fact with no source_url at all is demoted", () => {
  const block = { facts: [{ fact: "Runs the largest lab in India.", source_url: null, confidence: 0.99 }] };
  enforceSourcing(block, urls);
  assert.equal(block.facts[0].confidence, UNSOURCED_CONFIDENCE);
});

test("enforcement reaches hooks and the nested news/activity lists too", () => {
  const block = {
    hooks: [{ text: "Opened a new AI centre", source_url: "https://nope.example", confidence: 0.9 }],
    recent_news: [{ fact: "Signed an MOU.", source_url: "https://nope.example", confidence: 0.9 }],
    recent_activity: [{ fact: "Gave a keynote.", source_url: FETCHED, confidence: 0.85 }],
  };
  enforceSourcing(block, urls);
  assert.equal(block.hooks[0].confidence, UNSOURCED_CONFIDENCE);
  assert.equal(block.recent_news[0].confidence, UNSOURCED_CONFIDENCE);
  assert.equal(block.recent_activity[0].confidence, 0.85);
});

// ── hook selection ─────────────────────────────────────────────────────────

const hook = (over = {}) => ({
  text: "Opened a new AI centre in March",
  source_url: FETCHED, confidence: 0.9, is_trigger: false, date: null, scope: "org", ...over,
});

test("top_hooks is capped at 3 no matter how many candidates clear the floor", () => {
  // Deliberately unrelated wording: the cap must bite on its own, not as a side
  // effect of the near-duplicate pass.
  const many = [
    "Launched a robotics laboratory with industrial partners",
    "Hosts an annual genomics symposium every winter",
    "Publishes seismology datasets openly",
    "Runs a welding certification programme for local industry",
    "Maintains a botany herbarium of regional specimens",
    "Sponsors a competitive cricket academy",
    "Teaches typography inside its design school",
    "Operates a community opera outreach initiative",
  ].map((text) => hook({ text }));
  assert.equal(selectHooks(many).length, 3);
});

test("a hook below the citation floor is not a hook", () => {
  assert.equal(selectHooks([hook({ confidence: 0.5 })]).length, 0);
  assert.equal(selectHooks([hook({ confidence: CITATION_FLOOR })]).length, 1);
});

test("near-duplicate hooks collapse — five rewordings of one fact is one hook", () => {
  const chosen = selectHooks([
    hook({ text: "Opened a new artificial intelligence research centre" }),
    hook({ text: "Opened a new artificial intelligence research centre this year" }),
    hook({ text: "The new artificial intelligence research centre opened" }),
  ]);
  assert.equal(chosen.length, 1);
});

test("a person-level hook outranks an org-level one at equal confidence", () => {
  const chosen = selectHooks([
    hook({ scope: "org", text: "Ranked ninth nationally for engineering programmes" }),
    hook({ scope: "person", text: "Published a paper on federated learning benchmarks" }),
  ]);
  assert.equal(chosen[0].scope, "person");
});

test("a dated recent trigger outranks an undated fact", () => {
  const chosen = selectHooks([
    hook({ text: "Maintains a longstanding robotics laboratory facility" }),
    hook({ text: "Announced a semiconductor partnership last month", is_trigger: true, date: recent(20) }),
  ]);
  assert.match(chosen[0].text, /semiconductor/);
});

// ── trigger / coverage / tone ──────────────────────────────────────────────

test("an undated 'trigger' is a description, not a trigger", () => {
  assert.equal(pickTrigger([hook({ is_trigger: true, date: null })], []), "");
});

test("a trigger older than ~12 months no longer justifies writing now", () => {
  assert.equal(pickTrigger([hook({ is_trigger: true, date: recent(500) })], []), "");
  assert.notEqual(pickTrigger([hook({ is_trigger: true, date: recent(30) })], []), "");
});

test("coverage: fewer than 2 citable hooks is thin", () => {
  assert.equal(rateCoverage([], 5), "thin");
  assert.equal(rateCoverage([hook()], 5), "thin");
  assert.equal(rateCoverage([hook(), hook()], 5), "partial");
  assert.equal(rateCoverage([hook(), hook(), hook()], 5), "high");
});

test("coverage cannot be high off a single source", () => {
  assert.equal(rateCoverage([hook(), hook(), hook()], 1), "partial");
});

test("tone: ties break toward formal, and on_behalf is always formal", () => {
  assert.equal(recommendTone({ mode: "to_person", person: { current_title: "Dean of Research" } }), "formal");
  assert.equal(recommendTone({ mode: "to_person", person: { current_title: "PhD Student" } }), "warm");
  assert.equal(recommendTone({ mode: "on_behalf", target: { role: "Graduate Student" } }), "formal");
  assert.equal(recommendTone({ mode: "to_person", person: { current_title: "Growth Lead" }, org: { type: "company" } }), "peer");
});

// ── provenance ─────────────────────────────────────────────────────────────

test("provenance dedupes the same fact and keeps the better-sourced copy", () => {
  const prov = buildProvenance({
    person: { facts: [{ fact: "Heads the CSE department.", source_url: SNIPPET, confidence: 0.6 }] },
    org: { facts: [{ fact: "Heads the CSE department.", source_url: FETCHED, confidence: 0.9 }] },
  });
  assert.equal(prov.length, 1);
  assert.equal(prov[0].confidence, 0.9);
  assert.equal(prov[0].source_url, FETCHED);
});

test("provenance collapses one claim stated in two tenses", () => {
  // Both of these came back from a real nitt.edu extraction. Keeping both makes
  // one source look like two.
  const prov = buildProvenance({
    org: {
      facts: [
        { fact: "NIT Tiruchirappalli will coordinate NIMCET 2026 for MCA Admissions 2026-27.", source_url: FETCHED, confidence: 0.9 },
        { fact: "NIT Tiruchirappalli is coordinating NIMCET 2026 for MCA Admissions 2026-27.", source_url: FETCHED, confidence: 0.9 },
        { fact: "NIT Tiruchirappalli is ranked first among NITs in NIRF 2025.", source_url: FETCHED, confidence: 0.9 },
      ],
    },
  });
  assert.equal(prov.length, 2);
});

test("genuinely different facts about one subject are NOT collapsed", () => {
  const prov = buildProvenance({
    org: {
      facts: [
        { fact: "The department opened a new AI centre in March.", source_url: FETCHED, confidence: 0.9 },
        { fact: "The department runs a 900 student cohort.", source_url: FETCHED, confidence: 0.9 },
      ],
    },
  });
  assert.equal(prov.length, 2);
});

test("subject angle never ends on a dangling connective", () => {
  const out = synthesize({
    mode: "to_person",
    person: { full_name: "A B", hooks: [], facts: [] },
    org: { name: "X", hooks: [hook({ text: "NIT Tiruchirappalli was ranked first among NITs in NIRF 2025 rankings" })], facts: [] },
    sourcesChecked: 2,
  });
  assert.doesNotMatch(out.synthesis.suggested_subject_angle, /\b(in|on|at|to|of|for|and|with|the|by|from)$/i);
});

test("synthesize returns the documented shape and never more than 3 hooks", () => {
  const out = synthesize({
    mode: "to_person",
    person: { full_name: "Asha Rao", current_title: "Professor", hooks: [hook({ scope: "person" })], facts: [] },
    org: { name: "NIT Trichy", hooks: [hook(), hook({ text: "Runs a 900 student placement cohort" })], facts: [] },
    sourcesChecked: 4,
  });
  for (const k of ["person", "university", "synthesis", "provenance", "meta"]) assert.ok(k in out, `missing ${k}`);
  assert.ok(out.synthesis.top_hooks.length <= 3);
  assert.ok(["high", "partial", "thin"].includes(out.meta.coverage));
  assert.equal(typeof out.meta.researched_at, "string");
});

// ── email gates ────────────────────────────────────────────────────────────

const research = {
  person: { full_name: "Asha Rao", email: "asha@nitt.edu", current_title: "Professor", current_org: "NIT Trichy" },
  university: { name: "NIT Trichy", relevant_department: "Computer Science" },
  synthesis: {
    top_hooks: ["Opened a new AI centre in March"],
    trigger_event: "Opened a new AI centre in March",
    shared_context: "The department runs a 900 student cohort.",
    recommended_tone: "formal",
  },
  provenance: [
    { fact: "The department opened a new AI centre in March.", source_url: FETCHED, confidence: 0.9 },
    { fact: "The department runs a 900 student cohort.", source_url: FETCHED, confidence: 0.85 },
    { fact: "Unverified rumour about a grant.", source_url: SNIPPET, confidence: 0.6 },
  ],
  meta: { coverage: "partial", sources_checked: 3 },
};

const contract = buildEmailContract({
  research, mode: "to_person", emailIntent: "request a call",
  senderContext: "", minConfidence: 0.7, tone: "formal", maxWords: 150,
});

test("the contract hides every fact below min_confidence", () => {
  assert.equal(contract.allowed_facts.length, 2);
  assert.ok(!contract.allowed_facts.some((f) => /rumour/i.test(f.fact)));
});

test("raising min_confidence shrinks what the email is allowed to know", () => {
  const strict = buildEmailContract({ research, mode: "to_person", minConfidence: 0.88, tone: "formal", maxWords: 150 });
  assert.equal(strict.allowed_facts.length, 1);
});

const good = {
  subject: "your new AI centre, free for students",
  body: "Dear Professor Rao,\n\nYour department opened a new AI centre in March, and it changes what a cohort of that size can attempt. The department runs a 900 student cohort, which is where the work usually stalls. RadiusAI is free to your institution and free for every student. Would you be open to a short call next week?\n\nBest,\nSam\n\nKind regards,\nAryan Shivahare\nFounder & CEO, RadiusAI",
  hooksUsed: ["Opened a new AI centre in March"],
  factsCited: [
    { fact: "The department opened a new AI centre in March.", source_url: FETCHED },
    { fact: "The department runs a 900 student cohort.", source_url: FETCHED },
  ],
  contract,
};

test("a well-formed email passes every gate", () => {
  const v = validatePersonEmail(good);
  assert.equal(v.valid, true, `failed: ${v.failed.join(", ")}`);
});

test("the sanctioned free copy is not rejected as enterprise language", () => {
  // must_state's own lines say "with no procurement to navigate" and "No vendor,
  // no budget, no rollout". A flat word ban rejected the exact copy the product
  // block tells the model to use.
  for (const line of [
    "Available to your institution at no cost, with no procurement to navigate.",
    "No vendor, no budget, no rollout.",
    "There is no licence to buy and no deployment to schedule.",
  ]) {
    const v = validatePersonEmail({ ...good, body: `${good.body}\n${line}` });
    assert.equal(v.gates.banned_phrases.pass, true, `rejected sanctioned copy: ${line} -> ${v.gates.banned_phrases.detail}`);
  }
});

test("enterprise language is still caught when it is NOT negated", () => {
  for (const line of ["We can begin procurement next quarter.", "Our vendor team will handle the rollout."]) {
    const v = validatePersonEmail({ ...good, body: `${good.body}\n${line}` });
    assert.equal(v.gates.banned_phrases.pass, false, `accepted: ${line}`);
  }
});

test("a markdown-wrapped link fails the link gate, not the signature gate", () => {
  const body = good.body.replace("Would you be open to a short call next week?",
    "Visit [radiusai.online](https://www.radiusai.online/) to explore further.");
  const c = { ...contract, product: { name: "RadiusAI", url: "https://www.radiusai.online/" } };
  const v = validatePersonEmail({ ...good, body, contract: c });
  assert.equal(v.gates.product_link_present.pass, false);
  assert.match(v.gates.product_link_present.detail, /markdown/);
  assert.equal(v.gates.signature_real.pass, true, "a markdown link is not an unfilled placeholder");
});

test("signature_real still catches real placeholders next to a bare link", () => {
  const body = `${good.body}\nhttps://www.radiusai.online/\n[Your Position]`;
  const v = validatePersonEmail({ ...good, body });
  assert.equal(v.gates.signature_real.pass, false);
});

test("states_free fails when the free message is missing from the subject", () => {
  const v = validatePersonEmail({ ...good, subject: "your new AI centre" });
  assert.equal(v.gates.states_free.pass, false);
  assert.match(v.gates.states_free.detail, /subject/);
});

test("states_free fails when the free message is missing from the body", () => {
  const v = validatePersonEmail({ ...good, body: good.body.replace(/RadiusAI is free[^.]*\. /, "") });
  assert.equal(v.gates.states_free.pass, false);
  assert.match(v.gates.states_free.detail, /body/);
});

test("states_free accepts the alternative phrasings, not just the word 'free'", () => {
  for (const phrasing of ["at no cost", "zero cost", "costs your university nothing"]) {
    const v = validatePersonEmail({
      ...good,
      subject: `AI centre, ${phrasing}`,
      body: good.body.replace("RadiusAI is free to your institution and free for every student.", `RadiusAI comes at ${phrasing}.`),
    });
    assert.equal(v.gates.states_free.pass, true, `rejected: ${phrasing}`);
  }
});

test("superiority claims are rejected even though a real proof point now exists", () => {
  for (const bad of ["We are the best at this.", "RadiusAI is proven.", "We guarantee placements.", "We are #1."]) {
    const v = validatePersonEmail({ ...good, body: `${good.body}\n${bad}` });
    assert.equal(v.gates.banned_phrases.pass, false, `accepted: ${bad}`);
  }
});

test("the operational register is not rejected as informal", () => {
  // The handoff explicitly sanctions these for operational-tone roles. They were
  // never banned by name, but this pins it so a future banned-phrase sweep cannot
  // quietly outlaw the voice the spec asks for.
  const body = good.body.replace("Would you be open to a short call next week?",
    "It costs you nothing, so there's no reason not to, and it has never been easier to get your students ready.");
  const v = validatePersonEmail({ ...good, body });
  assert.equal(v.gates.banned_phrases.pass, true, v.gates.banned_phrases.detail || "");
});

test("'pilot' is citable — the sanctioned proof point is one", () => {
  const v = validatePersonEmail({ ...good, body: `${good.body}\nA pilot ran with the European School of Economics.` });
  assert.equal(v.gates.banned_phrases.pass, true, v.gates.banned_phrases.detail || "");
});

test("signature_real rejects a bracketed placeholder — the clearest tell of an unread email", () => {
  for (const bad of ["[Your Name]", "[Your Position]", "<name>", "{{sender}}"]) {
    const v = validatePersonEmail({ ...good, body: `${good.body}\n${bad}` });
    assert.equal(v.gates.signature_real.pass, false, `accepted ${bad}`);
  }
});

test("signature_real rejects an email that does not sign off as the sender", () => {
  const v = validatePersonEmail({ ...good, body: good.body.replace(/Aryan Shivahare/g, "Someone Else") });
  assert.equal(v.gates.signature_real.pass, false);
});

test("no_orphan_numbers catches a fabricated statistic", () => {
  const v = validatePersonEmail({ ...good, body: `${good.body} You rank 3rd in India.` });
  assert.equal(v.gates.no_orphan_numbers.pass, false);
  assert.match(v.gates.no_orphan_numbers.detail, /3/);
});

test("a hook the model invented is rejected", () => {
  const v = validatePersonEmail({ ...good, hooksUsed: ["We met at a conference in Berlin last spring"] });
  assert.equal(v.gates.hooks_within_top3.pass, false);
});

test("a cited fact that is not in allowed_facts is rejected", () => {
  const v = validatePersonEmail({
    ...good,
    factsCited: [{ fact: "She was promoted to Dean last month.", source_url: FETCHED }],
  });
  assert.equal(v.gates.facts_cited_allowed.pass, false);
});

test("the filler opener the spec bans is caught", () => {
  const v = validatePersonEmail({ ...good, body: `Dear Professor Rao,\n\nI hope this email finds you well. ${good.body}` });
  assert.equal(v.gates.banned_phrases.pass, false);
});

test("filler is a family, not one phrase — the variants a real generation produced are caught", () => {
  // Every one of these came out of an actual run against this prompt.
  for (const filler of [
    "I am reaching out to discuss the ATS-readiness of your students.",
    "Your institution's commitment to excellence is evident through such achievements.",
    "I wanted to reach out about your placement cell.",
    "Allow me to introduce myself and my company.",
  ]) {
    const v = validatePersonEmail({ ...good, body: `Dear Professor Rao,\n\n${filler}` });
    assert.equal(v.gates.banned_phrases.pass, false, `should ban: ${filler}`);
  }
});

test("padding a banned phrase does not evade the gate", () => {
  // A literal ban on "commitment to excellence" just moves the model one word
  // over; this is the evasion an actual run produced.
  for (const filler of [
    "This underscores the institute's commitment to academic excellence.",
    "Your dedication to research excellence is clear.",
    "Your impressive achievements speak for themselves.",
    "As you may know, ATS filters reject most CVs.",
  ]) {
    const v = validatePersonEmail({ ...good, body: `Dear Professor Rao,\n\n${filler}` });
    assert.equal(v.gates.banned_phrases.pass, false, `should ban: ${filler}`);
  }
});

test("specific, fact-anchored praise is still allowed", () => {
  // The gate must not become "never compliment anyone" — naming the actual fact
  // is the behaviour we want.
  const v = validatePersonEmail(good);
  assert.equal(v.gates.banned_phrases.pass, true);
});

test("max_words is enforced, not suggested", () => {
  const v = validatePersonEmail({ ...good, contract: { ...contract, max_words: 20 } });
  assert.equal(v.gates.max_words.pass, false);
});

test("when a trigger exists the email must actually open on it", () => {
  const v = validatePersonEmail({
    ...good,
    body: "Dear Professor Rao,\n\nWe build placement software for large institutions. Would you be open to a short call next week?\n\nBest,\nSam",
    hooksUsed: [], factsCited: [],
  });
  assert.equal(v.gates.opens_on_trigger.pass, false);
});

// ── cache keys ─────────────────────────────────────────────────────────────

test("org cache key is host-based when a url is known, so the whole campus shares one row", () => {
  assert.equal(orgKey({ university: "NIT Trichy", url: "https://www.nitt.edu/dept/cse" }), "nitt.edu");
  assert.equal(orgKey({ university: "  NIT   Trichy " }), "nit trichy");
});

test("person cache key prefers email, then linkedin, then name@org", () => {
  assert.equal(personKey({ email: "Asha@NITT.edu", linkedin_url: "x" }, "nitt.edu"), "asha@nitt.edu");
  assert.equal(personKey({ linkedin_url: "https://linkedin.com/in/asha/" }, "nitt.edu"), "https://linkedin.com/in/asha");
  assert.equal(personKey({ full_name: "Asha Rao" }, "nitt.edu"), "asha rao@nitt.edu");
});

test("LinkedIn and friends are never fetched — they serve an auth wall, not content", () => {
  for (const u of ["https://www.linkedin.com/in/x", "https://x.com/y", "https://facebook.com/z"]) {
    assert.equal(isUnfetchable(u), true, u);
  }
  assert.equal(isUnfetchable("https://nitt.edu/cse"), false);
});

// ── campaign gates (RadiusAI, India domain) ────────────────────────────────

const PRODUCT = {
  name: "RadiusAI",
  capabilities: [
    { name: "CV Builder", description: "Generates ATS-compliant resumes tailored to each student." },
    { name: "Dashboard & Application Tracker", description: "Helps students track applications." },
  ],
  proof_points: [], // the real state of radiusai.online: no stats, no customers
};

const campaign = (over = {}) => ({
  campaign_line: "Placement Matlab RadiusAI",
  line_meaning: "Placement means RadiusAI",
  theme: "Own the placement category",
  big_idea: "Speak to the placement cell in its own language.",
  audience: "Training and placement officers",
  pain_framing: "Most student CVs are filtered out before a recruiter reads them.",
  talking_points: ["ATS-compliant CV generation for every student", "One dashboard for application tracking"],
  subject_angles: ["placement season CVs"],
  cta: "Book a free demo",
  language_notes: "Hinglish, spoken",
  ...over,
});

test("campaign: the Coca-Cola shape passes — short, brand-named, category not statistic", () => {
  const v = validateCampaign({ campaign: campaign(), product: PRODUCT, input: {} });
  assert.equal(v.valid, true, `failed: ${v.failed.join(", ")}`);
});

test("campaign: a line that does not name the brand is not ownable", () => {
  const v = validateCampaign({ campaign: campaign({ campaign_line: "Placement Matlab Success" }), product: PRODUCT, input: {} });
  assert.equal(v.gates.line_names_brand.pass, false);
});

test("campaign: a sentence is not a line", () => {
  const v = validateCampaign({
    campaign: campaign({ campaign_line: "RadiusAI helps every student at your institution get placed faster" }),
    product: PRODUCT, input: {},
  });
  assert.equal(v.gates.line_length.pass, false);
});

test("campaign: with no proof_points, evidence-shaped claims are fabrication", () => {
  for (const line of ["Proven placement results", "The #1 placement platform", "Trusted by 200 colleges"]) {
    const v = validateCampaign({ campaign: campaign({ big_idea: line }), product: PRODUCT, input: {} });
    assert.equal(v.gates.no_unbacked_claims.pass, false, `should reject: ${line}`);
  }
});

test("campaign: a number with no source in the input is rejected", () => {
  const v = validateCampaign({ campaign: campaign({ big_idea: "We lift placement rates by 40 percent." }), product: PRODUCT, input: {} });
  assert.equal(v.gates.no_orphan_numbers.pass, false);
});

test("campaign: a number that IS in the input is allowed", () => {
  const v = validateCampaign({
    campaign: campaign({ big_idea: "Your 900 student cohort is the constraint." }),
    product: PRODUCT,
    input: { organisation: { facts: ["The department runs a 900 student cohort."] } },
  });
  assert.equal(v.gates.no_orphan_numbers.pass, true);
});

test("campaign: talking points cannot promise capabilities the product lacks", () => {
  const v = validateCampaign({
    campaign: campaign({ talking_points: ["Automated salary negotiation coaching for alumni"] }),
    product: PRODUCT, input: {},
  });
  assert.equal(v.gates.talking_points_grounded.pass, false);
});

test("campaign: a Hinglish line without a gloss cannot be reviewed", () => {
  const v = validateCampaign({ campaign: campaign({ line_meaning: "" }), product: PRODUCT, input: {} });
  assert.equal(v.gates.has_meaning.pass, false);
});

test("campaign: evidence-shaped claims become legal once proof_points actually exist", () => {
  const withProof = { ...PRODUCT, proof_points: [{ name: "pilot", description: "measured uplift" }] };
  const v = validateCampaign({ campaign: campaign({ big_idea: "Trusted by a London business school." }), product: withProof, input: {} });
  assert.equal(v.gates.no_unbacked_claims.pass, true);
});

test("campaign: inflected banned words are caught (leveraging, not just leverage)", () => {
  // A real campaign shipped "leveraging BIT Mesra's esteemed reputation": the
  // banned list held the string "leverage", which is not a substring of
  // "leveraging", so the substring match missed it entirely.
  const v = validateCampaign({ campaign: campaign({ cta: "Leveraging your reputation, let us talk." }), product: PRODUCT, input: {} });
  assert.equal(v.gates.banned_phrases.pass, false);
});

test("campaign: superiority claims stay banned even when proof_points exist", () => {
  // A pilot with one school licenses "we ran a pilot". It does not license "#1",
  // "best" or "proven" — so these must not become legal the day proof is added.
  const withProof = { ...PRODUCT, proof_points: [{ name: "pilot", description: "measured uplift" }] };
  for (const bad of ["Proven across India.", "The best placement tool.", "We are #1 for placements.", "We guarantee placements."]) {
    const v = validateCampaign({ campaign: campaign({ big_idea: bad }), product: withProof, input: {} });
    assert.equal(v.gates.no_unbacked_claims.pass, false, `accepted: ${bad}`);
  }
});

test("campaign: 'pilot' is not enterprise vocabulary — the sanctioned proof point is one", () => {
  const v = validateCampaign({ campaign: campaign({ big_idea: "A pilot ran at a London campus." }), product: PRODUCT, input: {} });
  assert.equal(v.gates.b2c_framing.pass, true);
});

// ── the product + campaign reach the email contract ────────────────────────

test("product and campaign land in the email contract, and proof_available says NONE", () => {
  const c = buildEmailContract({
    research, mode: "to_person", minConfidence: 0.7, tone: "formal", maxWords: 150,
    product: PRODUCT, campaign: campaign(),
  });
  assert.equal(c.product.name, "RadiusAI");
  assert.equal(c.campaign.campaign_line, "Placement Matlab RadiusAI");
  assert.match(String(c.proof_available), /NONE/);
});

test("a number from the product or campaign is not an orphan in the email", () => {
  const c = buildEmailContract({
    research, mode: "to_person", minConfidence: 0.7, tone: "formal", maxWords: 150,
    product: { ...PRODUCT, capabilities: [{ name: "CV Builder", description: "Covers all 3 formats." }] },
    campaign: campaign(),
  });
  const v = validatePersonEmail({
    subject: "s", body: "Dear Professor Rao, RadiusAI covers all 3 formats. Shall we speak?",
    hooksUsed: [], factsCited: [], contract: c, thin: true,
  });
  assert.equal(v.gates.no_orphan_numbers.pass, true);
});

test("subject_not_reused: a colleague at the same institution must not get the same subject", () => {
  const c = { ...contract, avoid_subjects: ["Unlock Placement Success with RadiusAI"] };
  const same = validatePersonEmail({ ...good, subject: "Unlock Placement Success with RadiusAI", contract: c });
  assert.equal(same.gates.subject_not_reused.pass, false);

  const near = validatePersonEmail({ ...good, subject: "Unlock Placement Success using RadiusAI now", contract: c });
  assert.equal(near.gates.subject_not_reused.pass, false, "a reworded duplicate is still a duplicate");

  const fresh = validatePersonEmail({ ...good, subject: "your new AI centre", contract: c });
  assert.equal(fresh.gates.subject_not_reused.pass, true);
});

test("subject_not_reused is inert when nothing has been sent to this institution yet", () => {
  assert.equal(validatePersonEmail(good).gates.subject_not_reused.pass, true);
});

test("subject shape follows rule 8: no colon, no Re:, not a sentence", () => {
  assert.equal(validatePersonEmail({ ...good, subject: "Demo: Enhance Placements at NIT" }).gates.subject_present.pass, false);
  assert.equal(validatePersonEmail({ ...good, subject: "Re: your placement cell" }).gates.subject_present.pass, false);
  assert.equal(validatePersonEmail({ ...good, subject: "" }).gates.subject_present.pass, false);
  assert.equal(validatePersonEmail({ ...good, subject: "your new AI centre" }).gates.subject_present.pass, true);
});

test("campaign: an identical line already running elsewhere is rejected", () => {
  // Both of these came out of one real batch, at two different universities.
  const v = validateCampaign({
    campaign: campaign({ campaign_line: "Placement ka Saathi RadiusAI" }),
    product: PRODUCT,
    input: { avoid_lines: ["Placement ka Saathi RadiusAI"] },
  });
  assert.equal(v.gates.line_is_distinct.pass, false);
});

test("campaign: the same idea with different punctuation is still the same idea", () => {
  const v = validateCampaign({
    campaign: campaign({ campaign_line: "Placements ka Saathi - RadiusAI" }),
    product: PRODUCT,
    input: { avoid_lines: ["Placement ka Saathi RadiusAI"] },
  });
  assert.equal(v.gates.line_is_distinct.pass, false, "singular/plural + dash is not a new campaign");
});

test("campaign: a genuinely different idea passes", () => {
  const v = validateCampaign({
    campaign: campaign({ campaign_line: "Har CV, RadiusAI Ready" }),
    product: PRODUCT,
    input: { avoid_lines: ["Placement ka Saathi RadiusAI", "Placement Ka Guru RadiusAI"] },
  });
  assert.equal(v.gates.line_is_distinct.pass, true);
});

test("campaign: the distinctiveness gate is inert for the first institution", () => {
  assert.equal(validateCampaign({ campaign: campaign(), product: PRODUCT, input: {} }).gates.line_is_distinct.pass, true);
});

test("tone stays formal for an academic contact even when research came back empty", () => {
  // A real run addressed a TPO at Aligarh Muslim University as a peer purely
  // because coverage was thin and the org block was empty.
  assert.equal(
    recommendTone({ mode: "to_person", person: { current_title: "Training and Placement Officer", university: "Aligarh Muslim University" }, org: {} }),
    "formal"
  );
});

test("generic praise with words wedged in is still generic praise", () => {
  const v = validatePersonEmail({
    ...good,
    body: "Dear Professor Rao,\n\nAligning with AITAM's commitment to academic and research excellence, we can help.",
  });
  assert.equal(v.gates.banned_phrases.pass, false);
});

// ── B2C framing (students are the customer, the institution buys nothing) ──

test("campaign: enterprise vocabulary is the wrong pitch, not just the wrong tone", () => {
  for (const bad of [
    "A pilot with one department before wider rollout.",
    "Cost-effective licence for your institution.",
    "Strong ROI for the placement cell.",
    "Our enterprise deployment is straightforward.",
  ]) {
    const v = validateCampaign({ campaign: campaign({ big_idea: bad }), product: PRODUCT, input: {} });
    assert.equal(v.gates.b2c_framing.pass, false, `should reject: ${bad}`);
  }
});

test("campaign: student-facing language passes the B2C gate", () => {
  const v = validateCampaign({
    campaign: campaign({ big_idea: "Students build an ATS-ready CV themselves before campus season." }),
    product: PRODUCT, input: {},
  });
  assert.equal(v.gates.b2c_framing.pass, true);
});

test("campaign: 'partner' stays allowed — it is the product's own CTA", () => {
  const v = validateCampaign({ campaign: campaign({ cta: "Partner With Us" }), product: PRODUCT, input: {} });
  assert.equal(v.gates.b2c_framing.pass, true);
});

test("email: procurement language is rejected in the body too", () => {
  const v = validatePersonEmail({
    ...good,
    body: "Dear Professor Rao, we could run a pilot and discuss licence terms for your institution.",
  });
  assert.equal(v.gates.banned_phrases.pass, false);
});

// ── follow-up gates (comparative: judged against the thread, not just a contract) ──

import { validateFollowup, buildFollowupContract, FOLLOWUP_STEPS } from "../src/lib/generateFollowup.js";

const ORIGINAL = {
  subject: "Enhance Student CVs with RadiusAI",
  body: "Dear Ms Kaushal,\n\nStudents at Vidya Jyothi apply to campus drives every season and most CVs never reach a recruiter because the parser drops them. RadiusAI gives each student an ATS compliant CV they build themselves in minutes. Would you share it with your final year batch?\n\nBest,\nA",
  tone: "formal",
  person_name: "Shikha Kaushal",
  org_name: "Vidya Jyothi Institute Of Technology",
};

const fContract = (step = 1, extra = {}) => ({
  ...buildFollowupContract({
    step,
    original: ORIGINAL,
    previous: extra.previous || [],
    product: PRODUCT,
    research: { provenance: [{ fact: "Runs a placement cell.", source_url: "https://vjit.ac.in", confidence: 0.9 }] },
  }),
  ...extra.contract,
});

const goodF = {
  subject: "one link for your final year batch",
  body: "Dear Ms Kaushal,\n\nThe application tracker is the part students tell us they miss most. It keeps every deadline in one place so nothing slips during drive season. Could you forward the link to one batch?\n\nBest,\nAryan Shivahare\nFounder & CEO, RadiusAI",
  newSpecific: "the application tracker keeps every deadline in one place",
  contract: fContract(1),
};

test("follow-up: a well-formed step 1 passes", () => {
  const v = validateFollowup(goodF);
  assert.equal(v.valid, true, `failed: ${v.failed.join(", ")}`);
});

test("follow-up: guilt and nudge language is rejected — silence is not a slight", () => {
  for (const bad of [
    "Just circling back on my last email.",
    "Following up to see if you saw this.",
    "Gentle reminder about my previous note.",
    "Did you get a chance to review my email?",
    "I know you're busy, but checking in.",
    "Haven't heard back from you.",
  ]) {
    const v = validateFollowup({ ...goodF, body: `Dear Ms Kaushal,\n\n${bad} The tracker keeps every deadline in one place.\n\nBest,\nA` });
    assert.equal(v.gates.no_guilt_trip.pass, false, `should reject: ${bad}`);
  }
});

test("follow-up: reusing the first email's subject makes the thread look automated", () => {
  const v = validateFollowup({ ...goodF, subject: "Enhance Student CVs with RadiusAI" });
  assert.equal(v.gates.subject_differs.pass, false);
});

test("follow-up: a sentence copied from the first email is a repeat, not a follow-up", () => {
  const v = validateFollowup({
    ...goodF,
    body: "Dear Ms Kaushal,\n\nRadiusAI gives each student an ATS compliant CV they build themselves in minutes. Could you forward it?\n\nBest,\nA",
  });
  assert.equal(v.gates.not_a_repeat.pass, false);
});

test("follow-up: each step must be shorter than everything before it", () => {
  const long = "word ".repeat(80).trim();
  const v = validateFollowup({ ...goodF, body: `Dear Ms Kaushal,\n\n${long}\n\nBest,\nA` });
  assert.equal(v.gates.shorter_than_previous.pass, false);
});

test("follow-up: it must add something genuinely new", () => {
  const missing = validateFollowup({ ...goodF, newSpecific: "" });
  assert.equal(missing.gates.adds_something_new.pass, false);

  const notInBody = validateFollowup({ ...goodF, newSpecific: "a completely unrelated claim about robotics funding" });
  assert.equal(notInBody.gates.adds_something_new.pass, false, "declared new_specific must actually appear in the body");
});

test("follow-up: no invented pricing — the site publishes none", () => {
  for (const bad of ["It is ₹499 per student.", "We can offer a discount for your batch.", "The subscription fee is low."]) {
    const v = validateFollowup({ ...goodF, body: `Dear Ms Kaushal,\n\n${bad} The tracker keeps every deadline in one place.\n\nBest,\nA` });
    assert.equal(v.gates.no_pricing.pass, false, `should reject: ${bad}`);
  }
});

test("follow-up: B2B procurement language is still wrong in a follow-up", () => {
  const v = validateFollowup({
    ...goodF,
    body: "Dear Ms Kaushal,\n\nWe could discuss licence terms and a rollout. The tracker keeps every deadline in one place.\n\nBest,\nA",
  });
  assert.equal(v.gates.banned_phrases.pass, false);
});

test("follow-up: step 2 is capped shorter than step 1", () => {
  assert.ok(FOLLOWUP_STEPS[2].max_words < FOLLOWUP_STEPS[1].max_words);
  assert.ok(FOLLOWUP_STEPS[2].send_after_days > FOLLOWUP_STEPS[1].send_after_days);
});

test("follow-up: the contract carries the full text of every earlier step", () => {
  const c = buildFollowupContract({
    step: 2,
    original: ORIGINAL,
    previous: [{ step_number: 1, subject: "one link", body: "short body here" }],
    product: PRODUCT,
  });
  assert.equal(c.thread.length, 2);
  assert.equal(c.thread[0].step, 0);
  assert.match(c.thread[0].body, /ATS compliant CV/);
  assert.equal(c.thread[1].step, 1);
});

test("follow-up: numbers must trace to the contract, same as the first email", () => {
  const v = validateFollowup({
    ...goodF,
    body: "Dear Ms Kaushal,\n\nThe tracker keeps every deadline in one place and lifts callbacks by 40 percent.\n\nBest,\nA",
  });
  assert.equal(v.gates.no_orphan_numbers.pass, false);
});

// ── correct addressee: the reader is the officer, not the student ──────────

test("subjects that address the recipient as the student are rejected", () => {
  // All five came out of one real batch of ten.
  for (const subj of [
    "Design Your Future with RadiusAI",
    "Ace Your Applications with RadiusAI",
    "Transform Your Job Hunt Today",
    "Maximise Your Placement Potential",
    "Launch Your Career with RadiusAI",
  ]) {
    const v = validatePersonEmail({ ...good, subject: subj });
    assert.equal(v.gates.correct_addressee.pass, false, `should reject: ${subj}`);
  }
});

test("'your students' is the correct second person and still passes", () => {
  for (const subj of [
    "Help Your Students Get Placement Ready",
    "Enhance Student CVs with RadiusAI",
    "ATS-ready CVs for your students",
  ]) {
    const v = validatePersonEmail({ ...good, subject: subj });
    assert.equal(v.gates.correct_addressee.pass, true, `should allow: ${subj}`);
  }
});

test("the addressee rule applies to the body as well as the subject", () => {
  const v = validatePersonEmail({
    ...good,
    body: "Dear Professor Rao, RadiusAI will improve your CV before placement season.",
  });
  assert.equal(v.gates.correct_addressee.pass, false);
});

test("an adjective between 'your' and the noun does not defeat the addressee gate", () => {
  // "Secure Your Dream Job with RadiusAI" shipped past the first version of this gate.
  for (const subj of [
    "Secure Your Dream Job with RadiusAI",
    "Build Your Perfect CV Today",
    "Land Your First Software Job",
  ]) {
    assert.equal(validatePersonEmail({ ...good, subject: subj }).gates.correct_addressee.pass, false, subj);
  }
});

test("correct student-possessive phrasing is not flagged", () => {
  for (const subj of [
    "Boost Your Students' Applications with RadiusAI",
    "Improve your student CVs before placement season",
    "Help your students build ATS-ready CVs",
  ]) {
    assert.equal(validatePersonEmail({ ...good, subject: subj }).gates.correct_addressee.pass, true, subj);
  }
});

