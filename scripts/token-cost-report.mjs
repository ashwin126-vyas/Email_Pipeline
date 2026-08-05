// Token + cost report, in rupees, built from MEASURED runs.
//
//   npm run cost:report -- --in=<measured.json> --out=token-cost-rupees.pdf
//
// Every unit figure here came from an instrumented run recorded by the token
// ledger in llm.js — per call, per stage, with the cached-input split. Nothing is
// estimated from prompt length, because that consistently understated the real
// bill: a retry doubles a stage, and cached input bills at half rate, so the two
// errors do not cancel.

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const OUT = resolve(arg("out", "token-cost-rupees.pdf"));
const HTML = OUT.replace(/\.pdf$/i, "") + ".html";
const M = JSON.parse(readFileSync(arg("in"), "utf8"));

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].find((p) => existsSync(p));

// ── pricing ─────────────────────────────────────────────────────────────────
const FX = 95.48025;                    // ₹ per USD
const PRICE = {                          // USD per 1M tokens
  "gpt-4o":      { input: 2.50, cached: 1.25, output: 10.00 },
  "gpt-4o-mini": { input: 0.15, cached: 0.075, output: 0.60 },
};
const SEARCH_TOOL_USD = 0.010;           // per web_search call on a mini model

// Cost of one ledger entry, charging cached input at its own lower rate.
const callCost = (c) => {
  const p = PRICE[c.model] || PRICE["gpt-4o"];
  const cached = c.cached_input || 0;
  const fresh = Math.max(0, c.input - cached);
  return ((fresh / 1e6) * p.input + (cached / 1e6) * p.cached + (c.output / 1e6) * p.output) * FX;
};
const sum = (calls) => calls.reduce((t, c) => ({
  calls: t.calls + 1,
  input: t.input + c.input,
  cached: t.cached + (c.cached_input || 0),
  output: t.output + c.output,
  inr: t.inr + callCost(c),
}), { calls: 0, input: 0, cached: 0, output: 0, inr: 0 });

// ── measured runs ───────────────────────────────────────────────────────────
const email = M.email_warm.gen.calls_detail;
const campaign = M.campaign.gen.calls_detail;
const fuB = M.followup.gen.calls_detail;
// The first follow-up sample, before the later run overwrote the scratch file.
const fuA = [
  { model: "gpt-4o", input: 3500, cached_input: 0, output: 205 },
  { model: "gpt-4o", input: 3582, cached_input: 3328, output: 213 },
];

const E = sum(email), E1 = sum(email.slice(0, 1));
const C = sum(campaign);
const FA = sum(fuA), FB = sum(fuB), F1 = sum(fuB.slice(0, 1));
const fuAvg = (FA.inr + FB.inr) / 2;

// Measured earlier in this project, not re-measured today — every run today was a
// cache hit, so research contributed nothing to today's spend.
const RESEARCH_COLD = 20.46;
const BATCH = { campaigns: 21, calls: 29, tokens: 94523, inr: 28.62 };

const r2 = (n) => `₹${n.toFixed(2)}`;
const N = (n) => n.toLocaleString("en-IN");

const row = (label, s, note = "") =>
  `<tr><td>${label}${note ? `<br><span class="dim">${note}</span>` : ""}</td>
     <td class="n">${s.calls}</td><td class="n">${N(s.input)}</td>
     <td class="n">${N(s.cached)}</td><td class="n">${N(s.output)}</td>
     <td class="n"><b>${r2(s.inr)}</b></td></tr>`;

// Per-contact / per-org scenarios.
const perContactClean = E1.inr;
const perContactRetry = E.inr;
const perContactFull = E.inr + fuAvg;              // email + one follow-up, both retried
const perNewOrg = C.inr + RESEARCH_COLD;

const projection = (contacts, orgs, cold) => {
  const org = orgs * (cold ? perNewOrg : C.inr);
  const people = contacts * perContactFull;
  return { org, people, total: org + people };
};
const p100w = projection(100, 6, false), p100c = projection(100, 6, true);
const p377w = projection(377, 21, false), p377c = projection(377, 21, true);

const projRow = (label, n, orgs, p, cold) =>
  `<tr><td>${label}<br><span class="dim">${n} contacts · ${orgs} organisations · ${cold ? "none researched yet" : "already researched (cache hit)"}</span></td>
     <td class="n">${r2(p.org)}</td><td class="n">${r2(p.people)}</td><td class="n"><b>${r2(p.total)}</b></td></tr>`;

const html = `<meta charset="utf-8"><title>RadiusAI — Token Consumption &amp; Cost (₹)</title><style>
 @page{size:A4;margin:17mm 14mm}
 body{font:11pt/1.55 -apple-system,Helvetica,Arial,sans-serif;color:#16181d;margin:0}
 h1{font-size:22pt;margin:0 0 4px;letter-spacing:-.5px}
 h2{font-size:10.5pt;text-transform:uppercase;letter-spacing:.9px;color:#5a6472;margin:20px 0 6px;padding-bottom:4px;border-bottom:1px solid #d8dde5}
 .sub{color:#5a6472;margin:2px 0 13px}
 table{width:100%;border-collapse:collapse;font-size:10pt;margin:6px 0 10px}
 th,td{text-align:left;padding:7px 9px;border-bottom:1px solid #e3e7ee;vertical-align:top}
 th{background:#f4f6f9;font-weight:600;border-bottom:1.5px solid #c9d1dc}
 td.n,th:not(:first-child){text-align:right}
 td.n{font-variant-numeric:tabular-nums;white-space:nowrap}
 tr.tot td{background:#f7f9fc;font-weight:700;border-top:1.5px solid #c9d1dc}
 .hero{display:flex;gap:12px;margin:12px 0}
 .main{flex:1.2;border-radius:9px;padding:15px 19px;background:#16181d;color:#fff}
 .main .big{font-size:34pt;font-weight:700;letter-spacing:-1.6px;margin:2px 0}
 .main .lbl{font-size:9pt;text-transform:uppercase;letter-spacing:.9px;opacity:.72}
 .main .sm{font-size:9pt;opacity:.85}
 .box{flex:1;border:1px solid #d8dde5;border-radius:9px;padding:15px 17px;background:#fbfcfe}
 .box .big{font-size:20pt;font-weight:700;letter-spacing:-.8px;margin:2px 0}
 .box .lbl{font-size:9pt;text-transform:uppercase;letter-spacing:.8px;color:#5a6472}
 .box .sm{font-size:8.5pt;color:#5a6472}
 .note{background:#fffdf6;border-left:3px solid #e0cf9a;padding:9px 12px;margin:9px 0;font-size:9.5pt}
 .dim{color:#5a6472;font-size:8.5pt}
 code{font:9.5pt ui-monospace,Menlo,monospace;background:#f2f4f8;padding:1px 4px;border-radius:3px}
 ul{margin:6px 0 10px;padding-left:18px} li{margin:3px 0}
 .pb{page-break-before:always}
</style>

<h1>Token Consumption &amp; Cost</h1>
<div class="sub">RadiusAI outreach pipeline · all figures in rupees at $1 = ₹${FX} · measured 5 August 2026</div>

<div class="hero">
  <div class="main">
    <div class="lbl">One contact, end to end</div>
    <div class="big">${r2(perContactFull)}</div>
    <div class="sm">Email + one follow-up, at an organisation already researched.<br>Includes the retry both stages actually took.</div>
  </div>
  <div class="box">
    <div class="lbl">One email</div>
    <div class="big">${r2(perContactRetry)}</div>
    <div class="sm">${r2(perContactClean)} when it passes<br>the gates first time</div>
  </div>
  <div class="box">
    <div class="lbl">One new organisation</div>
    <div class="big">${r2(perNewOrg)}</div>
    <div class="sm">research ${r2(RESEARCH_COLD)}<sup>†</sup><br>+ campaign ${r2(C.inr)}, once only</div>
  </div>
</div>

<div class="note"><b>These are measured, not estimated.</b> Each row below is a real run recorded
by the token ledger in <code>llm.js</code>, call by call. Two details move the number enough to matter:
a stage that fails a validation gate <b>retries once</b>, so it bills twice; and repeated prompt
prefixes come back as <b>cached input</b>, billed at half rate. Estimating from prompt length misses
both.</div>

<h2>Measured runs — 5 August 2026</h2>
<table>
<tr><th>Stage</th><th>Calls</th><th>Input</th><th>of which cached</th><th>Output</th><th>Cost</th></tr>
${row("Email, step 1 <b>(first attempt only)</b>", E1, "what a clean run costs")}
${row("Email, step 1 <b>as it actually ran</b>", E, "attempt + retry — row 127")}
${row("Campaign, per organisation", C, "measured probe, deliberately not saved")}
${row("Follow-up, step 2 — sample A", FA, "row 129 · attempt + retry")}
${row("Follow-up, step 2 — sample B", FB, "row 130 · attempt + retry, valid")}
<tr class="tot"><td>Email + follow-up, one contact</td><td class="n">${E.calls + FB.calls}</td>
  <td class="n">${N(E.input + FB.input)}</td><td class="n">${N(E.cached + FB.cached)}</td>
  <td class="n">${N(E.output + FB.output)}</td><td class="n">${r2(perContactFull)}</td></tr>
</table>

<h2>What the tokens cost</h2>
<table>
<tr><th>Model / meter</th><th>Where it runs</th><th>USD / 1M</th><th>₹ / 1M</th></tr>
<tr><td>gpt-4o — input</td><td>campaign + email + follow-up generation</td><td class="n">$2.50</td><td class="n">₹${(2.50 * FX).toFixed(0)}</td></tr>
<tr><td>gpt-4o — <b>cached</b> input</td><td>repeated prompt prefix, billed at half</td><td class="n">$1.25</td><td class="n">₹${(1.25 * FX).toFixed(0)}</td></tr>
<tr><td>gpt-4o — output</td><td>the generated email</td><td class="n">$10.00</td><td class="n">₹${(10.00 * FX).toFixed(0)}</td></tr>
<tr><td>gpt-4o-mini — input / output</td><td>web search + reply classification</td><td class="n">$0.15 / $0.60</td><td class="n">₹${(0.15 * FX).toFixed(0)} / ₹${(0.60 * FX).toFixed(0)}</td></tr>
<tr><td>web_search tool call</td><td>research only, ${SEARCH_TOOL_USD.toFixed(3)} per call</td><td class="n">$10 / 1k</td><td class="n">₹${(SEARCH_TOOL_USD * FX).toFixed(2)} each</td></tr>
</table>

<h2>Cached input is doing real work</h2>
<p>In the follow-up sample B, <b>${N(FB.cached)} of ${N(FB.input)} input tokens</b>
(${Math.round((FB.cached / FB.input) * 100)}%) were served from cache at half price. That is the
shared prefix — the system prompt, the product block, the campaign — being reused across attempts and
across contacts at the same institution. It is the main reason a second contact at one university is
cheaper than the first, independent of the research cache.</p>

<div class="pb"></div>
<h2>What a batch costs</h2>
<p>Per-contact cost is the email plus one follow-up (${r2(perContactFull)}). Organisation cost is paid
<b>once per institution</b>, not per contact — that split is the whole point of caching research and
campaigns at the org level.</p>
<table>
<tr><th>Batch</th><th>Organisation cost</th><th>Per-contact cost</th><th>Total</th></tr>
${projRow("100 contacts, orgs already researched", 100, 6, p100w, false)}
${projRow("100 contacts, all organisations new", 100, 6, p100c, true)}
${projRow("377 contacts, orgs already researched", 377, 21, p377w, false)}
${projRow("377 contacts, all organisations new", 377, 21, p377c, true)}
</table>
<p class="dim">377 contacts across 21 organisations is the current <code>prepare_data_one</code>
shape. The 21 organisations are already researched, so the first row of each pair is the live case;
the "all new" rows are what onboarding a fresh list would cost.</p>

<h2>Actually spent today</h2>
<table>
<tr><th>Work</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr>
<tr><td>Regenerating all ${BATCH.campaigns} campaigns against radius_product v2<br><span class="dim">two passes — 16 from cached research, 5 rebuilt from stored campaign input</span></td>
  <td class="n">${BATCH.calls}</td><td class="n">${N(BATCH.tokens)}</td><td class="n">${r2(BATCH.inr)}</td></tr>
<tr><td>Test generations for Smrita Dwivedi<br><span class="dim">rows 124–130: 4 emails, 3 follow-ups, incl. rejected runs</span></td>
  <td class="n">13</td><td class="n">~58,000</td><td class="n">~₹13.50</td></tr>
<tr><td>Campaign cost probe (not saved)</td><td class="n">${C.calls}</td>
  <td class="n">${N(C.input + C.output)}</td><td class="n">${r2(C.inr)}</td></tr>
<tr class="tot"><td>Today</td><td class="n">~43</td><td class="n">~155,000</td><td class="n">~₹43</td></tr>
</table>
<div class="note">The campaign-refresh figure is an <b>upper bound</b>: that script totalled input and
output without separating cached input, so it charged every input token at the full rate. The true
number is lower. Unit figures in the tables above do split it correctly.</div>

<h2>Where the money goes</h2>
<ul>
<li><b>Research dominates, and only for a new organisation.</b> ${r2(RESEARCH_COLD)}<sup>†</sup>
    against ${r2(C.inr)} for the campaign and ${r2(perContactFull)} for a contact — roughly
    ${Math.round(RESEARCH_COLD / perContactFull)}× a whole contact. Every run measured today was a
    cache hit, so research cost ₹0.</li>
<li><b>Output tokens cost 4× input, and 8× cached input.</b> A longer email is the most expensive
    thing to ask for. The current ${180}–${250} word target is already the bulk of the per-email cost.</li>
<li><b>Rejections are not free.</b> A gate failure retries once and bills twice — the difference
    between ${r2(perContactClean)} and ${r2(perContactRetry)} per email. Of the four emails generated
    for Smrita today, two were rejected, so the retry is a real line item, not an edge case.</li>
<li><b>Person research is gone.</b> Job title → objectives now comes from the
    <code>role_objectives</code> table, a one-time research cost amortised across all 377 contacts
    instead of ~₹1.92 each.</li>
</ul>

<h2>Levers, cheapest first</h2>
<ul>
<li><b>Do not re-research an organisation.</b> The 30-day org TTL is what keeps the live case at the
    first row of the batch table rather than the second. A needless <code>refresh</code> costs
    ${r2(RESEARCH_COLD)}<sup>†</sup> per org.</li>
<li><b>Reduce rejections before reducing tokens.</b> Two of today's four emails were rejected on
    <code>banned_phrases</code> and <code>correct_addressee</code>. Each one bought a full retry.
    Tightening the prompt against those two recurring failures is free and saves a duplicated call.</li>
<li><b>Search calls, not search tokens, are the research bill.</b> Each <code>web_search</code> call
    is ₹${(SEARCH_TOOL_USD * FX).toFixed(2)} flat on top of tokens. Query count per org is the knob
    (<code>SEARCH_QUERIES_PER_ORG</code>) — though an earlier A/B on cutting it was inconclusive on
    quality, so it is not a free win.</li>
<li><b>Generation must stay on gpt-4o.</b> gpt-4o-mini was tried and failed 8/8 generation attempts
    against these gates. It remains correct for search and classification, where it already runs.</li>
</ul>

<h2>Method</h2>
<p>Token counts come from the <code>usage</code> block OpenAI returns on every call, recorded by
<code>tokenLedger</code> in <code>src/lib/llm.js</code> before anything can throw, and by
<code>searchTokenLedger</code> in <code>src/lib/search.js</code> for search. Costs apply list prices
per model with cached input charged separately, converted at $1 = ₹${FX}.</p>
<p><sup>†</sup> <b>The one figure not measured today.</b> Cold organisation research —
search + crawl + extract — was measured earlier in this project at ${r2(RESEARCH_COLD)} per
organisation. Every run today hit the research cache, so re-measuring it would have meant paying for
a fresh crawl. Treat it as an order-of-magnitude figure that moves with page count and query count,
not a precise per-org constant.</p>
<p class="dim">Figures describe this pipeline's own API usage. They are not a reconciliation of the
OpenAI invoice — for billed totals, platform.openai.com/usage is the source of truth.</p>
`;

writeFileSync(HTML, html);
if (!CHROME) { console.log(`HTML written to ${HTML} (no Chrome found for PDF)`); process.exit(0); }
execFileSync(CHROME, ["--headless", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${OUT}`, HTML], { stdio: "ignore" });
console.log(`✓ ${OUT}`);
console.log(`  per email ${r2(perContactClean)} clean / ${r2(perContactRetry)} with retry`);
console.log(`  per follow-up ${r2(fuAvg)} avg · per campaign ${r2(C.inr)}`);
console.log(`  per contact end-to-end ${r2(perContactFull)}`);
console.log(`  HTML at ${HTML}`);
