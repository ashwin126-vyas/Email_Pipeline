// Cross-source corroboration — "combine search + pages, then filter".
//
// A fact's confidence used to come from ONE source and its sourcing tier. That is
// a floor against fabrication, but it throws away the strongest signal available:
// AGREEMENT. Two independent sources saying the same thing is different in kind
// from one source saying it twice.
//
//   · a snippet-only claim that a CRAWLED PAGE also states is promoted above the
//     citation floor — Google found it, we then read it ourselves;
//   · two pages on the SAME registrable domain are ONE source, or a site repeating
//     its own boilerplate would look like six witnesses;
//   · sources that DISAGREE on the same metric are worse than one source alone:
//     "94% placement" and "71% placement" means one is wrong and we cannot tell
//     which, so the claim is demoted below the floor and flagged disputed.
//
// All pure code. The model reports what each source says; who agrees with whom is
// arithmetic, not judgement.

const NORM = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9%.\s]/g, " ").replace(/\s+/g, " ").trim();

export function sourceDomain(url) {
  try {
    const host = new URL(String(url)).hostname.replace(/^www\./i, "").toLowerCase();
    const parts = host.split(".");
    if (parts.length <= 2) return host;
    const twoPartTld = /^(ac|co|edu|gov|org|net|nic|res)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
    return parts.slice(twoPartTld ? -3 : -2).join(".");
  } catch { return ""; }
}

const STOP = new Set(["the","a","an","and","or","of","in","at","to","for","with","on","by","is","are","was","were","has","have","had","its","their","this","that","from","as","it","be","been","also","which","who"]);

function contentWords(text) {
  return NORM(text).split(" ")
    // NORM keeps "." so decimals survive ("94.5%"), which glues the sentence-final
    // period to the last word — "drives." never matched "drives". Strip edge dots.
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length > 2 && /^[a-z0-9%.]+$/.test(w) && !STOP.has(w));
}

export function claimSimilarity(a, b) {
  const A = new Set(contentWords(a)), B = new Set(contentWords(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

export function numbersIn(text) {
  return [...new Set((String(text ?? "").match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, "")))];
}

// Two claims about the SAME metric with DIFFERENT numbers conflict. Two claims
// about different metrics that merely contain different numbers do not.
const METRIC_TERMS = [
  ["placement_rate", /\b(placement|placed)\b.*\b(rate|percent|%)|\b(rate|percent|%)\b.*\bplace/i],
  ["package", /\b(package|ctc|salary|lpa|stipend)\b/i],
  ["cohort", /\b(students?|cohort|batch|intake|strength|enrol)\w*\b/i],
  ["recruiters", /\b(recruiters?|companies|firms|employers)\b/i],
  ["ranking", /\b(rank|ranked|ranking|nirf)\b/i],
  ["founded", /\b(founded|established|since|inception)\b/i],
];
const metricOf = (t) => (METRIC_TERMS.find(([, re]) => re.test(t)) || [null])[0];

export const CORROBORATION_BONUS = 0.2;
export const DISPUTED_CONFIDENCE = 0.4;

export function corroborate(facts, { similarity = 0.55, floor = 0.7 } = {}) {
  const list = (facts || []).filter((f) => f && f.fact);
  const groups = [];
  for (const f of list) {
    const hit = groups.find((g) => claimSimilarity(g.representative, f.fact) >= similarity);
    if (hit) hit.members.push(f); else groups.push({ representative: f.fact, members: [f] });
  }

  const report = { corroborated: [], disputed: [], single_source: 0, groups: groups.length };
  const out = [];

  for (const g of groups) {
    const domains = new Set(g.members.map((m) => sourceDomain(m.source_url)).filter(Boolean));
    const independent = domains.size;
    const metric = metricOf(g.representative);
    const numberSets = g.members.map((m) => numbersIn(m.fact)).filter((n) => n.length);
    let disputed = false;
    if (metric && independent > 1 && numberSets.length > 1) {
      const first = numberSets[0].join("|");
      disputed = numberSets.some((n) => n.join("|") !== first);
    }

    const best = [...g.members].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    const supporting = [...new Set(g.members.map((m) => m.source_url).filter(Boolean))];
    let confidence = Number(best.confidence) || 0;
    let status = "single_source";

    if (disputed) {
      confidence = Math.min(confidence, DISPUTED_CONFIDENCE);
      status = "disputed";
      report.disputed.push({ claim: g.representative, sources: supporting, values: numberSets });
    } else if (independent > 1) {
      confidence = Math.min(1, confidence + CORROBORATION_BONUS);
      if (confidence < floor) confidence = floor;
      status = "corroborated";
      report.corroborated.push({ claim: g.representative, domains: [...domains] });
    } else {
      report.single_source++;
    }

    out.push({
      ...best,
      confidence: Math.round(confidence * 100) / 100,
      corroboration: status,
      independent_sources: independent,
      supporting_urls: supporting,
      variants: g.members.length > 1 ? g.members.map((m) => m.fact) : undefined,
    });
  }
  return { facts: out, report };
}
