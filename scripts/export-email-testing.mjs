// Export email_testing rows to a PDF report — every column, nothing truncated.
//
//   npm run export:testing                      # ids 25-34 (the current B2C batch)
//   npm run export:testing -- --ids=25,26,27
//   npm run export:testing -- --thread=131   # one email + its follow-ups, shared stages once
//   npm run export:testing -- --threads=142,150,160  # several threads, one document
//   npm run export:testing -- --all
//   npm run export:testing -- --out=/path/to/report.pdf
//
// Renders HTML and prints it with headless Chrome, which is the only PDF path on
// this machine that handles page breaks and monospace wrapping properly. The
// prompt and JSONB columns are the whole point of the table, so they are printed
// in full rather than summarised — expect a long document.

import { pool } from "../src/lib/db.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const idArg = args.find((a) => a.startsWith("--ids="));
const threadArg = args.find((a) => a.startsWith("--thread="));
const threadsArg = args.find((a) => a.startsWith("--threads="));
const outArg = args.find((a) => a.startsWith("--out="));
const all = args.includes("--all");

const OUT = resolve(outArg ? outArg.slice(6) : "email-testing-records.pdf");
const HTML = OUT.replace(/\.pdf$/i, "") + ".html";

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].find((p) => existsSync(p));

// ── data ────────────────────────────────────────────────────────────────────

const ids = idArg ? idArg.slice(6).split(",").map((s) => Number(s.trim())).filter(Boolean) : null;

const { rows: columns } = await pool.query(
  `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
    WHERE table_name = 'email_testing'
    ORDER BY ordinal_position`
);

// --thread walks one chain of parent_id links from a root, so an initial email and
// its follow-ups come back as ONE document instead of N near-identical ones.
const threadRoot = threadArg ? Number(threadArg.slice(9)) : null;
// --threads=142,150,160 puts several complete threads in ONE document, each with
// its own shared-context block. Used for sample packs across universities.
const threadRoots = threadsArg
  ? threadsArg.slice(10).split(",").map((x) => Number(x.trim())).filter(Boolean)
  : threadRoot ? [threadRoot] : null;

// Only valid emails, and only the newest at each step. A rejected attempt is a
// branch that was never sent, and three of them hanging off step 2 turned a
// four-email thread into a seven-record document.
const THREAD_SQL = `WITH RECURSIVE chain AS (
     SELECT * FROM email_testing WHERE id = $1
     UNION ALL
     SELECT c.* FROM email_testing c JOIN chain ON c.parent_id = chain.id
      WHERE c.is_valid
   )
   SELECT DISTINCT ON (step_number) * FROM chain
    ORDER BY step_number, created_at DESC, id DESC`;

const threads = [];
if (threadRoots) {
  for (const root of threadRoots) {
    const { rows: t } = await pool.query(THREAD_SQL, [root]);
    if (t.length) threads.push(t);
  }
}

const rows = threadRoots
  ? threads.flat()
  : (await pool.query(
      all
        ? `SELECT * FROM email_testing ORDER BY id`
        : ids
        ? `SELECT * FROM email_testing WHERE id = ANY($1::int[]) ORDER BY id`
        : `SELECT * FROM email_testing WHERE id BETWEEN 25 AND 34 ORDER BY id`,
      all ? [] : ids ? [ids] : []
    )).rows;

if (!rows.length) {
  console.error("No matching rows in email_testing.");
  await pool.end();
  process.exit(1);
}

// ── rendering ───────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// NB: the Date check must come first. A Date has no own enumerable keys, so the
// generic "empty object" test below swallowed every timestamp and printed
// created_at as "— empty —".
const isEmpty = (v) => v instanceof Date ? false :
  v == null || (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) ||
  (typeof v === "string" && v.trim() === "");

/** Long text and JSON get a scrollable-in-print <pre>; scalars get an inline value. */
function renderValue(v) {
  if (isEmpty(v)) return `<span class="null">— empty —</span>`;
  if (v instanceof Date) return `<span class="val">${esc(v.toISOString())}</span>`;
  if (typeof v === "boolean") return `<span class="bool ${v}">${v}</span>`;
  if (typeof v === "number") return `<span class="val">${esc(v)}</span>`;
  if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.join("").length < 300) {
    return `<ul class="arr">${v.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  }
  if (typeof v === "object") return `<pre class="json">${esc(JSON.stringify(v, null, 2))}</pre>`;
  const s = String(v);
  if (s.length > 120 || s.includes("\n")) return `<pre class="text">${esc(s)}</pre>`;
  return `<span class="val">${esc(s)}</span>`;
}

const chars = (v) => (v == null ? 0 : typeof v === "string" ? v.length : JSON.stringify(v).length);

// The four pipeline stages, so the report reads in the order the data was produced
// rather than in column order.
const GROUPS = [
  { title: "Identity and run metadata", fields: ["id", "run_label", "created_at", "mode", "email_intent", "org_key", "org_name", "person_name", "person_email", "status", "is_valid", "provider", "model", "error"] },
  { title: "Linked rows (soft references)", fields: ["person_research_id", "org_research_id", "radius_product_id", "radius_campaign_id"] },
  { title: "Stage 1 — Research (them)", fields: ["research_input", "research_output"] },
  { title: "Stage 2 — Radius (us)", fields: ["radius_input", "radius_output"] },
  { title: "Stage 3 — Campaign (per organisation)", fields: ["campaign_cached", "campaign_input", "campaign_prompt_system", "campaign_prompt_user", "campaign_output"] },
  { title: "Follow-up thread", fields: ["step_number", "parent_id", "previous_subject", "previous_body"] },
  { title: "Stage 4 — Email (per person)", fields: ["email_input", "email_prompt_system", "email_prompt_user", "email_contract", "email_output"] },
  { title: "Result and validation", fields: ["subject", "body", "coverage", "tone", "warnings", "validation"] },
];

const known = new Set(GROUPS.flatMap((g) => g.fields));
const ungrouped = columns.map((c) => c.column_name).filter((c) => !known.has(c));
if (ungrouped.length) GROUPS.push({ title: "Other columns", fields: ungrouped });

const allFollowups = rows.every((r) => (r.step_number || 1) > 1);
const generated = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
const totalChars = rows.reduce((n, r) => n + Object.values(r).reduce((m, v) => m + chars(v), 0), 0);

const summaryRows = rows
  .map(
    (r) => `<tr>
      <td>${r.id}</td>
      <td>${r.step_number === 1 ? "1 initial" : `${r.step_number} follow-up`}</td>
      <td>${esc(r.person_name)}</td>
      <td>${esc(r.org_name)}</td>
      <td>${esc(r.coverage)}</td>
      <td class="${r.is_valid ? "ok" : "bad"}">${r.is_valid ? "valid" : "rejected"}</td>
      <td>${esc(r.subject)}</td>
    </tr>`
  )
  .join("");

// In thread mode the pipeline stages that produced the whole thread — research,
// the product row, the campaign — are printed ONCE, because they are identical
// for every step by construction: a follow-up reuses the cached research and the
// org's campaign rather than redoing them. Repeating them per step made a
// four-email thread a 111-page document that was 80% the same bytes.
const SHARED_GROUPS = new Set([
  "Identity and run metadata", "Linked rows (soft references)",
  "Stage 1 — Research (them)", "Stage 2 — Radius (us)",
  "Stage 3 — Campaign (per organisation)",
]);
const SHARED_ONLY_FIELDS = new Set([
  "mode", "email_intent", "org_key", "org_name", "person_name", "person_email",
  "provider", "model", "person_research_id", "org_research_id",
  "radius_product_id", "radius_campaign_id",
  "research_input", "research_output", "radius_input", "radius_output",
  "campaign_cached", "campaign_input", "campaign_prompt_system",
  "campaign_prompt_user", "campaign_output",
]);

const renderGroups = (r, keep) => GROUPS.map((g) => {
  const fields = g.fields.filter((f) => f in r && keep(f, g));
  if (!fields.length) return "";
  const items = fields.map((f) => {
    const col = columns.find((c) => c.column_name === f);
    const size = chars(r[f]);
    return `<div class="field">
      <div class="fname">${esc(f)}
        <span class="ftype">${esc(col?.data_type || "")}${size > 200 ? ` · ${size.toLocaleString()} chars` : ""}</span>
      </div>
      <div class="fval">${renderValue(r[f])}</div>
    </div>`;
  }).join("");
  return `<section class="group"><h3>${esc(g.title)}</h3>${items}</section>`;
}).join("");

const threadSections = (trows, chapter = null) => {
  const initial = trows.find((r) => (r.step_number || 1) === 1) || trows[0];
  const followups = trows.filter((r) => r !== initial);
  const emailBlock = (r, label) => `<article class="record">
    <header class="rhead">
      <div class="rid">email_testing · id ${r.id}${r.parent_id ? ` · follow-up to id ${r.parent_id}` : ""}</div>
      <h2>${esc(label)}</h2>
      <div class="rmeta">
        <span>${esc(r.subject || "no subject")}</span>
        <span>${String(r.body || "").trim().split(/\s+/).filter(Boolean).length} words</span>
        <span class="${r.is_valid ? "ok" : "bad"}">${r.is_valid ? "valid draft" : "rejected"}</span>
        <span>${esc(r.run_label || "")}</span>
        <span>${r.created_at instanceof Date ? r.created_at.toISOString().slice(0, 19).replace("T", " ") : ""}</span>
      </div>
    </header>
    ${renderGroups(r, (f) => !SHARED_ONLY_FIELDS.has(f))}
  </article>`;

  return `${chapter ? `<article class="record chapter"><header class="rhead">
      <div class="rid">${chapter.personOnly ? "contact" : "sample"} ${chapter.n} of ${chapter.total}</div>
      <h2>${esc(chapter.personOnly ? initial.person_name : initial.org_name)}</h2>
      <div class="rmeta"><span>${esc(chapter.personOnly ? initial.org_name : initial.person_name)}</span>
        <span>${esc(initial.person_email || "")}</span>
        <span>coverage: <b>${esc(initial.coverage)}</b></span>
        <span>${trows.length} emails</span></div></header></article>` : ""}
  ${chapter?.personOnly ? "" : `<article class="record">
    <header class="rhead">
      <div class="rid">shared across all ${trows.length} emails in this thread</div>
      <h2>${esc(initial.person_name)} <span class="at">at</span> ${esc(initial.org_name)}</h2>
      <div class="rmeta">
        <span>${esc(initial.person_email || "no email")}</span>
        <span>coverage: <b>${esc(initial.coverage)}</b></span>
        <span>tone: <b>${esc(initial.tone)}</b></span>
        <span>${trows.length} emails · 1 initial + ${followups.length} follow-up${followups.length === 1 ? "" : "s"}</span>
      </div>
    </header>
    <p class="lede">Research, the RadiusAI product row and the organisation campaign are shown once:
    every email below was written from these same inputs. Only what changes per email — its own
    prompt, contract, output and gates — is repeated in the sections that follow.</p>
    ${renderGroups(initial, (f, g) => SHARED_GROUPS.has(g.title) && f !== "id" && f !== "run_label"
        && f !== "created_at" && f !== "status" && f !== "is_valid" && f !== "error")}
  </article>`}
  <article class="record"><header class="rhead"><div class="rid">the email</div>
    <h2>Email — step 1</h2></header></article>
  ${emailBlock(initial, "Initial email")}
  <article class="record"><header class="rhead"><div class="rid">the sequence</div>
    <h2>Follow-up emails (${followups.length})</h2></header>
    <p class="lede">Each follow-up is written against the full text of every email before it, which is
    why <code>previous_subject</code> and <code>previous_body</code> differ at every step and the word
    count falls monotonically.</p></article>
  ${followups.map((r, i) => emailBlock(r, `Follow-up ${i + 1} — step ${r.step_number}, sent +${[3, 7, 14][i] ?? "?"} days`)).join("")}`;
};

// When every thread belongs to the SAME organisation, the research and campaign
// are one row shared by all of them — that is the design ("one campaign per
// university, one email per person"), so printing them per person would repeat
// identical bytes and hide the very thing worth seeing. Emit them once, then just
// the people.
const oneOrg = threads.length > 1 &&
  new Set(threads.map((t) => String(t[0].org_key || "").toLowerCase())).size === 1;

const sharedOrgBlock = () => {
  const r = threads[0][0];
  const total = threads.reduce((n, t) => n + t.length, 0);
  return `<article class="record">
    <header class="rhead">
      <div class="rid">shared by all ${threads.length} people · ${total} emails</div>
      <h2>${esc(r.org_name)}</h2>
      <div class="rmeta">
        <span>${esc(r.org_key)}</span>
        <span>coverage: <b>${esc(r.coverage)}</b></span>
        <span>${threads.length} contacts</span>
      </div>
    </header>
    <p class="lede">One organisation, researched once and given one campaign. Every email below was
    written from these same inputs — what differs per person is their role, their contract and their
    own thread. Researching this university three times would have produced the same paragraph three
    times and three different pitches for one institution.</p>
    ${renderGroups(r, (f, g) => SHARED_GROUPS.has(g.title) && f !== "id" && f !== "run_label"
        && f !== "created_at" && f !== "status" && f !== "is_valid" && f !== "error"
        && f !== "person_name" && f !== "person_email")}
  </article>`;
};

const recordSections = threadRoots
  ? (oneOrg
      ? sharedOrgBlock() + threads.map((t, i) =>
          threadSections(t, { n: i + 1, total: threads.length, personOnly: true })).join("")
      : threads.map((t, i) =>
          threadSections(t, threads.length > 1 ? { n: i + 1, total: threads.length } : null)).join(""))
  : rows
  .map((r) => {
    const groups = GROUPS.map((g) => {
      const fields = g.fields.filter((f) => f in r);
      if (!fields.length) return "";
      const items = fields
        .map((f) => {
          const col = columns.find((c) => c.column_name === f);
          const size = chars(r[f]);
          return `<div class="field">
            <div class="fname">${esc(f)}
              <span class="ftype">${esc(col?.data_type || "")}${size > 200 ? ` · ${size.toLocaleString()} chars` : ""}</span>
            </div>
            <div class="fval">${renderValue(r[f])}</div>
          </div>`;
        })
        .join("");
      return `<section class="group"><h3>${esc(g.title)}</h3>${items}</section>`;
    }).join("");

    return `<article class="record">
      <header class="rhead">
        <div class="rid">email_testing · id ${r.id}</div>
        <h2>${esc(r.person_name)} <span class="at">at</span> ${esc(r.org_name)}</h2>
        <div class="rmeta">
          <span>${esc(r.person_email || "no email")}</span>
          <span>coverage: <b>${esc(r.coverage)}</b></span>
          <span>tone: <b>${esc(r.tone)}</b></span>
          <span class="${r.is_valid ? "ok" : "bad"}">${r.is_valid ? "valid draft" : "rejected"}</span>
          <span>step ${r.step_number}${r.parent_id ? ` (follow-up to id ${r.parent_id})` : " (initial)"}</span>
          <span>${esc(r.run_label || "")}</span>
        </div>
      </header>
      ${groups}
    </article>`;
  })
  .join("");

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>email_testing records</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font: 10pt/1.45 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #16181d; margin: 0; }
  h1 { font-size: 22pt; margin: 0 0 4px; letter-spacing: -0.4px; }
  h2 { font-size: 13pt; margin: 2px 0 6px; }
  h3 { font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.8px; color: #5a6472;
       margin: 14px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #d8dde5; }
  .chapter { page-break-before: always; background: #16181d; color: #fff; }
  .chapter .rid, .chapter .rmeta, .chapter .rmeta b { color: #c9d1dc; }
  .chapter h2 { color: #fff; font-size: 17pt; }
  .lede { font-size: 9.5pt; color: #3c4553; background: #f7f9fc; border-left: 3px solid #c9d1dc;
          padding: 8px 11px; margin: 8px 0 4px; }
  .cover { padding: 30mm 0 10mm; border-bottom: 3px solid #16181d; margin-bottom: 12px; }
  .sub { color: #5a6472; font-size: 10.5pt; margin: 2px 0; }
  .facts { margin-top: 14px; font-size: 9.5pt; color: #3c4553; }
  .facts div { margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; margin-top: 6px; }
  th, td { text-align: left; padding: 4px 5px; border-bottom: 1px solid #e3e7ee; vertical-align: top;
           overflow-wrap: anywhere; }
  /* Auto layout starved the narrow columns until "25" wrapped to "2/5" and
     "formal" to "form/al". Pin them and let the prose columns take the slack. */
  .summary th:nth-child(1), .summary td:nth-child(1) { width: 26px; white-space: nowrap; }
  .summary th:nth-child(2), .summary td:nth-child(2) { width: 15%; }
  .summary th:nth-child(4), .summary td:nth-child(4),
  .summary th:nth-child(5), .summary td:nth-child(5),
  .summary th:nth-child(6), .summary td:nth-child(6) { width: 52px; white-space: nowrap; }
  th { background: #f4f6f9; font-weight: 600; border-bottom: 1.5px solid #c9d1dc; }
  .record { page-break-before: always; }
  .rhead { border-left: 4px solid #16181d; padding: 2px 0 4px 10px; margin-bottom: 4px; }
  .rid { font: 8pt ui-monospace, "SF Mono", Menlo, monospace; color: #7a8494; }
  .at { color: #8a94a4; font-weight: 400; }
  .rmeta { font-size: 8.5pt; color: #5a6472; display: flex; flex-wrap: wrap; gap: 12px; }
  .group { page-break-inside: auto; }
  .field { margin: 7px 0; page-break-inside: avoid; }
  .fname { font: 8.5pt ui-monospace, "SF Mono", Menlo, monospace; font-weight: 600; color: #1f2937; }
  .ftype { font-weight: 400; color: #97a0af; margin-left: 6px; font-size: 7.5pt; }
  .fval { margin-top: 2px; }
  .val { font-size: 9.5pt; }
  .null { color: #a6adb9; font-style: italic; font-size: 9pt; }
  .bool.true { color: #16794a; font-weight: 600; }
  .bool.false { color: #a3341f; font-weight: 600; }
  .ok { color: #16794a; font-weight: 600; }
  .bad { color: #a3341f; font-weight: 600; }
  ul.arr { margin: 2px 0 2px 16px; padding: 0; font-size: 9pt; }
  pre { font: 8pt/1.4 ui-monospace, "SF Mono", Menlo, monospace; background: #f7f9fc;
        border: 1px solid #e3e7ee; border-left: 3px solid #c3ccd9; border-radius: 3px;
        padding: 6px 8px; margin: 3px 0;
        white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
  pre.text { background: #fffdf6; border-left-color: #e0cf9a; }
  pre.json { background: #f7f9fc; }
</style></head><body>

<div class="cover">
  <h1>${allFollowups ? "Follow-up emails" : "email_testing"} — full record export</h1>
  <div class="sub">Every column of the <code>email_testing</code> table, for ${rows.length} record${rows.length === 1 ? "" : "s"}.</div>
  <div class="facts">
    <div><b>Records:</b> id ${rows[0].id}–${rows[rows.length - 1].id} (${rows.length})</div>
    <div><b>Columns per record:</b> ${columns.length}</div>
    <div><b>Total data:</b> ${totalChars.toLocaleString()} characters</div>
    <div><b>Source:</b> Apollodb · public.email_testing · public.prepare_data_one</div>
    <div><b>Generated:</b> ${generated}</div>
    <div style="margin-top:8px;color:#7a8494">Nothing in this document was sent. All rows are generated drafts.</div>
  </div>
</div>

<h3>Summary</h3>
<table class="summary">
  <thead><tr><th>id</th><th>Step</th><th>Person</th><th>Organisation</th><th>Coverage</th><th>Status</th><th>Subject</th></tr></thead>
  <tbody>${summaryRows}</tbody>
</table>

<h3>Column reference (${columns.length})</h3>
<table>
  <thead><tr><th>Column</th><th>Type</th><th>Nullable</th></tr></thead>
  <tbody>${columns
    .map((c) => `<tr><td><code>${esc(c.column_name)}</code></td><td>${esc(c.data_type)}</td><td>${esc(c.is_nullable)}</td></tr>`)
    .join("")}</tbody>
</table>

${recordSections}
</body></html>`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(HTML, html, "utf8");

if (!CHROME) {
  console.log(`Chrome not found — wrote HTML only: ${HTML}`);
  console.log(`Open it and "Print to PDF", or install Chrome and re-run.`);
  await pool.end();
  process.exit(0);
}

execFileSync(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--no-pdf-header-footer",
  "--virtual-time-budget=30000",
  `--print-to-pdf=${OUT}`,
  `file://${HTML}`,
], { stdio: "pipe" });

console.log(`✓ ${OUT}`);
console.log(`  ${rows.length} records · ${columns.length} columns each · ${totalChars.toLocaleString()} chars`);
console.log(`  HTML source kept at ${HTML}`);

await pool.end();
