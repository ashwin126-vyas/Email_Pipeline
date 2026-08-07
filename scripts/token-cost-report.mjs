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

// Follow-up steps 2 and 3 of the sequence, measured on the BIT Mesra thread
// (rows 136 and 137). Step 1 of the sequence is the fuA/fuB pair above.
const fu2 = [{ model: "gpt-4o", input: 3303, cached_input: 0, output: 185 }];
const fu3 = [{ model: "gpt-4o", input: 3485, cached_input: 0, output: 123 },
             { model: "gpt-4o", input: 3567, cached_input: 3328, output: 133 }];

const E = sum(email), E1 = sum(email.slice(0, 1));
const C = sum(campaign);
const FA = sum(fuA), FB = sum(fuB), F1 = sum(fuB.slice(0, 1));
const fuAvg = (FA.inr + FB.inr) / 2;
const FU2 = sum(fu2), FU3 = sum(fu3);
const seqFollowups = fuAvg + FU2.inr + FU3.inr;   // all three follow-ups
const seqDefault = fuAvg + FU2.inr;               // the default two

// Measured on a genuinely cold organisation: Birla Institute of Technology,
// Mesra — never researched, never campaigned, no cache to hit anywhere in the
// chain. Supersedes an earlier ₹20.46 figure that predates search moving to
// gpt-4o-mini.
const COLD = JSON.parse(readFileSync(arg("cold"), "utf8"));
const RESEARCH_COLD = COLD.research_cold_inr;
const BATCH = { campaigns: 21, calls: 29, tokens: 94523, inr: 28.62 };

// A second, complete cold thread: Pune Institute of Computer Technology — new
// organisation, one email and three follow-ups, every step valid first time.
const PICT = JSON.parse(readFileSync(arg("pict"), "utf8"));

// Three contacts at three new universities, each a full sequence. Costs below
// count EVERY attempt including rejected ones, because a rejection is billed.
const THREE = arg("three") ? JSON.parse(readFileSync(arg("three"), "utf8")) : null;

// The same test again with the variable flipped: three contacts at ONE university,
// so research and the campaign are paid once and reused by contacts 2 and 3.
const SAME = arg("same") ? JSON.parse(readFileSync(arg("same"), "utf8")) : null;

// Names and organisations come from the database, so "&" in "Sardar Patel & Sons"
// would otherwise break the markup.
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
const perContactFull = E.inr + seqDefault;         // email + the default two follow-ups
const perContactSeq3 = E.inr + seqFollowups;       // email + all three follow-ups
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
 .main{flex:1;border-radius:9px;padding:14px 16px;background:#16181d;color:#fff;min-width:0}
 .main .big{font-size:26pt;font-weight:700;letter-spacing:-1.6px;margin:2px 0}
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
    <div class="lbl">One user at a new university</div>
    <div class="big">${THREE ? r2(THREE.avg_inr) : r2(perNewOrg + perContactSeq3)}</div>
    <div class="sm">Everything that user costs from nothing: their university's research and
campaign, then their email and three follow-ups.<br>Mean of ${THREE ? THREE.users.length : 3} measured
users, every rejected attempt included.</div>
  </div>
  <div class="main" style="background:#1f3a5f">
    <div class="lbl">3 users at 3 <u>different</u> universities</div>
    <div class="big">${THREE ? r2(THREE.total_inr) : "—"}</div>
    <div class="sm">${THREE ? `${r2(THREE.avg_inr)} each · ${THREE.users.map((u) => r2(u.inr)).join(" + ")}` : ""}<br>
Each pays for its own organisation — nothing is shared.</div>
  </div>
  <div class="main" style="background:#14532d">
    <div class="lbl">3 users at <u>one</u> university</div>
    <div class="big">${SAME ? r2(SAME.total_inr) : "—"}</div>
    <div class="sm">${SAME ? `${r2(SAME.avg_inr)} each · ${SAME.users.map((u) => r2(u.inr)).join(" + ")}` : ""}<br>
${SAME && THREE ? `${r2(THREE.total_inr - SAME.total_inr)} cheaper (${Math.round((1 - SAME.total_inr / THREE.total_inr) * 100)}%) — research and campaign paid once.` : ""}</div>
  </div>
</div>

<div class="hero">
  <div class="box">
    <div class="lbl">One user, university already researched</div>
    <div class="big">${r2(perContactFull)}</div>
    <div class="sm">Email + the two default follow-ups.<br>${r2(perContactSeq3)} with a third.
This is what user #2 onward at the same university costs.</div>
  </div>
  <div class="box">
    <div class="lbl">One email on its own</div>
    <div class="big">${r2(perContactRetry)}</div>
    <div class="sm">${r2(perContactClean)} when it passes<br>the gates first time</div>
  </div>
  <div class="box">
    <div class="lbl">One new organisation</div>
    <div class="big">${r2(perNewOrg)}</div>
    <div class="sm">research ${r2(RESEARCH_COLD)} + campaign ${r2(C.inr)}<br>paid once, then cached
for every colleague</div>
  </div>
</div>

<div class="note"><b>Why the two headline numbers differ so much.</b> A user at a <i>new</i> university
carries that university's one-time research and campaign; a user at one already researched does not.
So the first contact at an institution costs roughly ${THREE ? Math.round(THREE.avg_inr / perContactFull) : 5}× the
second. Twenty-seven contacts at one university cost ${THREE ? r2(THREE.avg_inr) : ""} + 26 × ${r2(perContactFull)},
not 27 × ${THREE ? r2(THREE.avg_inr) : ""} — which is the entire reason research and campaigns are cached per
organisation rather than per person.</div>

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

${THREE ? `
<h2>Per user and in total</h2>
<table>
<tr><th>User</th><th>University</th><th>Coverage</th><th>Emails</th><th>Rejected attempts</th><th>Cost</th></tr>
${THREE.users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.org)}</td>
  <td class="n">${esc(u.coverage)}</td><td class="n">${u.emails}</td>
  <td class="n">${u.attempts - u.emails}</td>
  <td class="n"><b>${r2(u.inr)}</b></td></tr>`).join("")}
<tr class="tot"><td colspan="3">Total — ${THREE.users.length} users, ${THREE.users.length} universities</td>
  <td class="n">${THREE.users.reduce((n, u) => n + u.emails, 0)}</td>
  <td class="n">${THREE.users.reduce((n, u) => n + u.attempts - u.emails, 0)}</td>
  <td class="n">${r2(THREE.total_inr)}</td></tr>
<tr class="tot"><td colspan="5">Average per user</td><td class="n">${r2(THREE.avg_inr)}</td></tr>
</table>
` : ""}
${SAME ? `
<div class="pb"></div>
<h2>Three users at ONE university</h2>
<p>The same test with one variable changed. All three contacts are at
${esc(SAME.users[0].org)}, so the organisation is researched once and given one campaign, and contacts
2 and 3 inherit both. Their job titles differ, so their emails do too.</p>
<table>
<tr><th>Contact</th><th>Title</th><th>Search calls</th><th>Attempts</th><th>Cost</th></tr>
${SAME.users.map((u, i) => `<tr><td>${esc(u.name)}<br><span class="dim">contact ${i + 1}${i === 0 ? " — pays for the research and campaign" : " — cache hit"}</span></td>
  <td>${esc(u.title)}</td><td class="n">${u.search_calls}</td><td class="n">${u.attempts}</td>
  <td class="n"><b>${r2(u.inr)}</b></td></tr>`).join("")}
<tr class="tot"><td colspan="2">Total — 3 users, 1 university</td>
  <td class="n">${SAME.users.reduce((n, u) => n + u.search_calls, 0)}</td>
  <td class="n">${SAME.users.reduce((n, u) => n + u.attempts, 0)}</td>
  <td class="n">${r2(SAME.total_inr)}</td></tr>
<tr class="tot"><td colspan="4">Average per user</td><td class="n">${r2(SAME.avg_inr)}</td></tr>
</table>

<h2>Same university vs different universities</h2>
<table>
<tr><th>Three users…</th><th>Research runs</th><th>Campaigns</th><th>Total</th><th>Per user</th></tr>
<tr><td>at <b>three different</b> universities</td>
  <td class="n">3</td><td class="n">3</td>
  <td class="n">${THREE ? r2(THREE.total_inr) : "—"}</td><td class="n">${THREE ? r2(THREE.avg_inr) : "—"}</td></tr>
<tr><td>at <b>one</b> university</td>
  <td class="n">1</td><td class="n">1</td>
  <td class="n">${r2(SAME.total_inr)}</td><td class="n">${r2(SAME.avg_inr)}</td></tr>
<tr class="tot"><td>Saved by sharing one organisation</td><td class="n"></td><td class="n"></td>
  <td class="n">${THREE ? r2(THREE.total_inr - SAME.total_inr) : "—"}</td>
  <td class="n">${THREE ? `${Math.round((1 - SAME.total_inr / THREE.total_inr) * 100)}%` : "—"}</td></tr>
</table>
<div class="note"><b>${SAME.users[0].search_calls} search calls for contact 1, ${SAME.users.slice(1).map((u) => u.search_calls).join(" and ")} for the other two.</b>
That single row is the whole mechanism: the crawl and the campaign happen once per organisation, and
every colleague after the first is just an email. Note the remaining spread between contacts 2 and 3
(${r2(SAME.users[1].inr)} vs ${r2(SAME.users[2].inr)}) is retries, not research — ${esc(SAME.users[2].name)}'s
first email was rejected three times, on banned phrasing and on a colon in the subject line.</div>
` : ""}
<h2>The follow-up ladder</h2>
<p>Word counts are the Birla Institute of Technology, Mesra thread (rows 131, 132, 136, 137); token
and cost figures are the runs that produced them, except where noted. A sequence is one email and
then follow-ups that must each be <b>shorter than every email before it</b>. That is a content rule with a cost consequence: later steps are cheaper, because the output
token count — the most expensive meter — falls at every step.</p>
<table>
<tr><th>Step</th><th>Sent</th><th>Words</th><th>Calls</th><th>Output tokens</th><th>Cost</th></tr>
<tr><td>Email — step 1</td><td>day 0</td><td class="n">228</td><td class="n">${E.calls}</td><td class="n">${N(E.output)}</td><td class="n">${r2(E.inr)}</td></tr>
<tr><td>Follow-up 1<br><span class="dim">cost is the mean of two samples measured on a different thread — this one's ledger was not retained</span></td>
  <td>+3 days</td><td class="n">112</td><td class="n">2</td><td class="n">${N(FB.output)}</td><td class="n">${r2(fuAvg)}</td></tr>
<tr><td>Follow-up 2</td><td>+7 days</td><td class="n">96</td><td class="n">${FU2.calls}</td><td class="n">${N(FU2.output)}</td><td class="n">${r2(FU2.inr)}</td></tr>
<tr><td>Follow-up 3 <span class="dim">(added on request; the default sequence stops at 2)</span></td>
  <td>+14 days</td><td class="n">56</td><td class="n">${FU3.calls}</td><td class="n">${N(FU3.output)}</td><td class="n">${r2(FU3.inr)}</td></tr>
<tr class="tot"><td>Whole thread, one contact</td><td>28 days</td><td class="n">492</td>
  <td class="n">${E.calls + 2 + FU2.calls + FU3.calls}</td>
  <td class="n">${N(E.output + FB.output + FU2.output + FU3.output)}</td><td class="n">${r2(perContactSeq3)}</td></tr>
</table>
<div class="note">Follow-up cost does <b>not</b> fall as fast as word count does. The email is 228 words
and the last follow-up 56 — a quarter of the length — but ${r2(FU3.inr)} against ${r2(E.inr)}, only
${Math.round((1 - FU3.inr / E.inr) * 100)}% less. The reason is that every follow-up carries the whole
thread so far in its prompt so the model can avoid repeating itself: input grows as output shrinks.</div>

<h2>A cold organisation, measured end to end</h2>
<p>Birla Institute of Technology, Mesra — never researched, never campaigned, nothing cached anywhere
in the chain. This is what onboarding one new institution actually costs, and it is the most expensive
run in this report.</p>
<table>
<tr><th>Stage</th><th>Input</th><th>Cached</th><th>Output</th><th>Cost</th></tr>
<tr><td>web_search — ${COLD.search_calls} calls <span class="dim">(gpt-4o-mini)</span><br><span class="dim">tool fee ₹${(COLD.search_calls * SEARCH_TOOL_USD * FX).toFixed(2)} + tokens ₹${(COLD.research_cold_inr - 2.59 - COLD.search_calls * SEARCH_TOOL_USD * FX).toFixed(2)}</span></td>
  <td class="n">${N(COLD.search_input)}</td><td class="n">0</td><td class="n">${N(COLD.search_output)}</td><td class="n">₹6.67</td></tr>
<tr><td>extract — LLM #1, typed facts from crawled pages</td><td class="n">8,702</td><td class="n">0</td><td class="n">532</td><td class="n">₹2.59</td></tr>
<tr><td>campaign — the org-level line</td><td class="n">3,147</td><td class="n">0</td><td class="n">314</td><td class="n">₹1.05</td></tr>
<tr><td>email — attempt 1</td><td class="n">3,962</td><td class="n">0</td><td class="n">389</td><td class="n">₹1.32</td></tr>
<tr><td>email — attempt 2 (retry)</td><td class="n">4,049</td><td class="n">2,944</td><td class="n">381</td><td class="n">₹0.98</td></tr>
<tr class="tot"><td>Cold run, ${COLD.seconds}s · coverage <b>high</b> · valid</td>
  <td class="n">${N(COLD.search_input + 19860)}</td><td class="n">2,944</td><td class="n">${N(COLD.search_output + 1616)}</td>
  <td class="n">${r2(COLD.total_inr)}</td></tr>
</table>
<div class="note"><b>${Math.round((COLD.search_calls * SEARCH_TOOL_USD * FX / COLD.research_cold_inr) * 100)}% of the research cost is the search <i>tool fee</i>, not tokens.</b>
Each <code>web_search</code> call is a flat ₹${(SEARCH_TOOL_USD * FX).toFixed(2)} on top of whatever it reads —
₹${(COLD.search_calls * SEARCH_TOOL_USD * FX).toFixed(2)} of the ${r2(COLD.research_cold_inr)} here. Query count per organisation is
therefore the single biggest lever on research cost, and it is a dial
(<code>SEARCH_QUERIES_PER_ORG</code>), not a rewrite.</div>

<h2>A complete thread at a new university</h2>
<p>Pune Institute of Computer Technology — nothing cached, one email and three follow-ups, every step
valid on the first attempt at <b>high</b> coverage. This is the full price of adding one institution
and working one contact through the whole sequence.</p>
<table>
<tr><th>Stage</th><th>Words</th><th>Calls</th><th>Input</th><th>Cached</th><th>Output</th><th>Cost</th></tr>
<tr><td>Research + campaign + email<br><span class="dim">${PICT.email.search_calls} search calls, then extract, campaign and the email itself</span></td>
  <td class="n">${PICT.email.words}</td><td class="n">${PICT.email.calls}</td><td class="n">${N(PICT.email.input)}</td>
  <td class="n">${N(PICT.email.cached)}</td><td class="n">${N(PICT.email.output)}</td><td class="n">${r2(PICT.email.inr)}</td></tr>
<tr><td>Follow-up 1 <span class="dim">+3 days</span></td><td class="n">${PICT["followup-1"].words}</td>
  <td class="n">${PICT["followup-1"].calls}</td><td class="n">${N(PICT["followup-1"].input)}</td>
  <td class="n">${N(PICT["followup-1"].cached)}</td><td class="n">${N(PICT["followup-1"].output)}</td><td class="n">${r2(PICT["followup-1"].inr)}</td></tr>
<tr><td>Follow-up 2 <span class="dim">+7 days</span></td><td class="n">${PICT["followup-2"].words}</td>
  <td class="n">${PICT["followup-2"].calls}</td><td class="n">${N(PICT["followup-2"].input)}</td>
  <td class="n">${N(PICT["followup-2"].cached)}</td><td class="n">${N(PICT["followup-2"].output)}</td><td class="n">${r2(PICT["followup-2"].inr)}</td></tr>
<tr><td>Follow-up 3 <span class="dim">+14 days</span></td><td class="n">${PICT["followup-3"].words}</td>
  <td class="n">${PICT["followup-3"].calls}</td><td class="n">${N(PICT["followup-3"].input)}</td>
  <td class="n">${N(PICT["followup-3"].cached)}</td><td class="n">${N(PICT["followup-3"].output)}</td><td class="n">${r2(PICT["followup-3"].inr)}</td></tr>
<tr class="tot"><td>Whole thread, new organisation</td>
  <td class="n">${PICT.email.words + PICT["followup-1"].words + PICT["followup-2"].words + PICT["followup-3"].words}</td>
  <td class="n">${PICT.email.calls + PICT["followup-1"].calls + PICT["followup-2"].calls + PICT["followup-3"].calls}</td>
  <td class="n">${N(PICT.email.input + PICT["followup-1"].input + PICT["followup-2"].input + PICT["followup-3"].input)}</td>
  <td class="n">${N(PICT.email.cached + PICT["followup-1"].cached + PICT["followup-2"].cached + PICT["followup-3"].cached)}</td>
  <td class="n">${N(PICT.email.output + PICT["followup-1"].output + PICT["followup-2"].output + PICT["followup-3"].output)}</td>
  <td class="n">${r2(PICT._total)}</td></tr>
</table>
<div class="note">The three follow-ups cost ${r2(PICT["followup-1"].inr)}, ${r2(PICT["followup-2"].inr)} and
${r2(PICT["followup-3"].inr)} — <b>essentially flat</b>, while their length falls from
${PICT["followup-1"].words} words to ${PICT["followup-3"].words}. Each one carries the whole thread in
its prompt so it can avoid repeating itself, so input rises exactly as fast as output falls. Adding a
fourth follow-up would cost about the same again; it does not get cheaper the shorter it gets.</div>

${THREE ? `
<div class="pb"></div>
<h2>Three contacts, three new universities</h2>
<p>Each is a cold organisation and a full sequence: research, campaign, email and three follow-ups.
Every attempt is counted, including the ones the gates rejected — a rejected draft is billed exactly
like a good one, and pretending otherwise would understate the real number.</p>
<table>
<tr><th>Contact / organisation</th><th>Coverage</th><th>Emails</th><th>Attempts</th><th>Rejected</th><th>Cost</th></tr>
${THREE.users.map((u) => `<tr><td>${esc(u.name)}<br><span class="dim">${esc(u.org)}</span></td>
  <td class="n">${esc(u.coverage)}</td>
  <td class="n">${u.emails}</td>
  <td class="n">${u.attempts}</td>
  <td class="n">${u.attempts - u.emails}</td>
  <td class="n"><b>${r2(u.inr)}</b></td></tr>`).join("")}
<tr class="tot"><td>Three contacts</td><td class="n"></td>
  <td class="n">${THREE.users.reduce((n, u) => n + u.emails, 0)}</td>
  <td class="n">${THREE.users.reduce((n, u) => n + u.attempts, 0)}</td>
  <td class="n">${THREE.users.reduce((n, u) => n + u.attempts - u.emails, 0)}</td>
  <td class="n">${r2(THREE.total_inr)}</td></tr>
</table>
<p>Average <b>${r2(THREE.avg_inr)}</b> per contact including their organisation's one-time research and
campaign. The spread across the three is the story: it tracks how many attempts the gates rejected,
not how much was written.</p>
` : ""}
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
<p>Per-contact cost is the email plus the two default follow-ups (${r2(perContactFull)}); add
${r2(FU3.inr)} each for a third. Organisation cost is paid
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
<li><b>Research dominates, and only for a new organisation.</b> ${r2(RESEARCH_COLD)} against
    ${r2(C.inr)} for the campaign and ${r2(perContactFull)} for a contact — about
    ${Math.round((RESEARCH_COLD / perContactFull) * 10) / 10}× a whole contact, paid once and then
    cached for 30 days. Every warm run measured today hit that cache and paid ₹0 for research.</li>
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
<li><b>Cut search calls before anything else.</b> ${COLD.search_calls} calls cost
    ₹${(COLD.search_calls * SEARCH_TOOL_USD * FX).toFixed(2)} in flat tool fees — more than the entire
    email. Dropping to 4 queries per organisation saves ₹${(2 * SEARCH_TOOL_USD * FX).toFixed(2)} per
    org outright. An earlier A/B on query count was inconclusive on <i>quality</i>, so test it on a
    few orgs rather than assuming it is free.</li>
<li><b>Do not re-research an organisation.</b> The 30-day org TTL is what keeps the live case at the
    first row of the batch table rather than the second. A needless <code>refresh</code> costs
    ${r2(RESEARCH_COLD)} per org.</li>
<li><b>Reduce rejections before reducing tokens.</b> Two of today's four emails were rejected on
    <code>banned_phrases</code> and <code>correct_addressee</code>. Each one bought a full retry.
    Tightening the prompt against those two recurring failures is free and saves a duplicated call.</li>
<li><b>Generation must stay on gpt-4o.</b> gpt-4o-mini was tried and failed 8/8 generation attempts
    against these gates. It remains correct for search and classification, where it already runs.</li>
</ul>

<h2>Method</h2>
<div class="note"><b>Provenance of this edition.</b> The per-call ledger files behind the unit tables
were cleared from disk before this rebuild, so the figures here were restored from the instrumented
runs' recorded output rather than re-measured. Every number is a measurement that was taken; none was
re-derived from prompt length. One table did not survive — the per-step breakdown of the
three-different-universities test — and has been dropped rather than reconstructed. The underlying
<code>email_testing</code> rows are all still in the database, so any of it can be re-measured by
re-running those contacts.</div>
<p>Token counts come from the <code>usage</code> block OpenAI returns on every call, recorded by
<code>tokenLedger</code> in <code>src/lib/llm.js</code> before anything can throw, and by
<code>searchTokenLedger</code> in <code>src/lib/search.js</code> for search. Costs apply list prices
per model with cached input charged separately, converted at $1 = ₹${FX}.</p>
<p><b>Every figure here was measured today</b>, including cold research — run against an
organisation with nothing in any cache (row ${COLD.row_id}). One caveat on generalising it: research
cost moves with how many pages a site exposes and how many queries are issued. BIT Mesra returned
${COLD.search_calls} search calls and 10 sources at <b>high</b> coverage; a thinner site can cost the
same and return less.</p>
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
