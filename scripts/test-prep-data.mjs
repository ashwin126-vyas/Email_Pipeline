// Batch-run the email_testing chain over real rows from prepare_data_one.
//
//   npm run test:prep                 # first 10 rows that have a website
//   npm run test:prep -- 25           # first 25
//   npm run test:prep -- --ids=157,158,159
//   npm run test:prep -- --ids=586 --refresh-campaign   # regenerate that org's campaign
//   npm run test:prep -- --ids=157,158 --followup       # write step 2 for those people
//
// Sequential on purpose. Each row can trigger a crawl plus two or three model
// calls, and the point of this script is a readable pass/fail table over real
// data, not throughput.
//
// Nothing is sent. Every run lands in email_testing as a draft or a rejection.

import { pool } from "../src/lib/db.js";
import { runEmailTest } from "../src/lib/emailTesting.js";
import { searchProvider } from "../src/lib/search.js";

const args = process.argv.slice(2);
const idArg = args.find((a) => a.startsWith("--ids="));
const limit = Number(args.find((a) => /^\d+$/.test(a))) || 10;
// Force a fresh campaign even when one is cached for that org — use after
// changing the campaign prompt or gates.
const refreshCampaign = args.includes("--refresh-campaign");
// Generate the NEXT step for people who already have an email, reusing their
// cached research and their institution's existing campaign.
const followup = args.includes("--followup");
// B2C: the officer is a route to their students, not a buyer.
const intent = "introduce RadiusAI to your students so they can build ATS-ready CVs themselves";

const { rows } = idArg
  ? await pool.query(
      `SELECT id, name, title, company, email, linkedin, industry, website_url
         FROM prepare_data_one WHERE id = ANY($1::int[]) ORDER BY company, id`,
      [idArg.slice(6).split(",").map((s) => Number(s.trim())).filter(Boolean)]
    )
  : await pool.query(
      // A website is what makes org research possible without a search key, so
      // rows without one are skipped here rather than run to a guaranteed thin
      // result. Pass --ids explicitly to test those on purpose.
      `SELECT id, name, title, company, email, linkedin, industry, website_url
         FROM prepare_data_one
        WHERE website_url IS NOT NULL AND website_url <> ''
        ORDER BY id LIMIT $1`,
      [limit]
    );

if (!rows.length) {
  console.error("No matching rows in prepare_data_one.");
  await pool.end();
  process.exit(1);
}

console.log(`Running ${rows.length} row(s) from prepare_data_one`);
console.log(`Search provider: ${searchProvider() || "NONE (org research uses website_url only)"}\n`);

const results = [];
for (const [i, r] of rows.entries()) {
  const label = `${i + 1}/${rows.length}`;
  process.stdout.write(`[${label}] ${r.name} — ${r.company} ... `);
  const started = Date.now();
  try {
    const out = await runEmailTest({
      person: {
        full_name: r.name,
        email: r.email,
        position: r.title,
        university: r.company,
        linkedin_url: r.linkedin,
        org_url: r.website_url,
      },
      email_intent: intent,
      constraints: { max_words: 140 },
      refresh_campaign: refreshCampaign,
      followup,
      run_label: `prepare_data_one#${r.id}${followup ? " followup" : ""}`,
    });
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    if (out.error) {
      console.log(`ERROR (${secs}s): ${out.error}`);
      results.push({ id: r.id, name: r.name, company: r.company, status: "error", detail: out.error });
      continue;
    }
    const failed = Object.entries(out.email.validation || {})
      .filter(([, g]) => !g.pass)
      .map(([n]) => n);
    console.log(
      `${out.email.valid ? "ok" : "REJECTED"} (${secs}s) coverage=${out.research.meta.coverage} ` +
        `campaign=${out.campaign?.cached ? "cached" : "new"}`
    );
    results.push({
      id: r.id,
      row: `#${out.id}`,
      name: r.name,
      company: (r.company || "").slice(0, 34),
      coverage: out.research.meta.coverage,
      hooks: out.research.synthesis.top_hooks.length,
      step: out.step_number,
      campaign: out.campaign?.cached ? "cached" : "new",
      line: (out.campaign?.campaign_line || "").slice(0, 34),
      subject: (out.email.subject || "").slice(0, 38),
      status: out.email.valid ? "draft" : "rejected",
      detail: failed.join(",") || "",
    });
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
    results.push({ id: r.id, name: r.name, company: r.company, status: "failed", detail: e.message });
  }
}

console.log("\n=== RESULTS ===");
console.table(results);

const drafts = results.filter((r) => r.status === "draft").length;
const rejected = results.filter((r) => r.status === "rejected").length;
const errored = results.filter((r) => r.status === "error" || r.status === "failed").length;
const thin = results.filter((r) => r.coverage === "thin").length;
const cached = results.filter((r) => r.campaign === "cached").length;

console.log(`\ndrafts ${drafts} · rejected ${rejected} · errored ${errored}`);
console.log(`coverage thin: ${thin}/${results.length} · campaigns reused from cache: ${cached}`);
console.log(`\nAll runs are in email_testing. Nothing was sent.`);

await pool.end();
