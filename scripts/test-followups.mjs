// Generate the 2-step follow-up sequence for email_testing rows.
//
//   npm run test:followup                    # ids 25-34 (the current B2C batch)
//   npm run test:followup -- --ids=25,26
//   npm run test:followup -- --regenerate    # rewrite steps that already exist
//
// Sequential, and the steps within one thread are strictly ordered: step 2 is
// written against the real step 1, never in parallel with it.
//
// Nothing is sent. Every step lands in followup_testing as a draft or a rejection.

import { pool } from "../src/lib/db.js";
import { runFollowupTest } from "../src/lib/followupTesting.js";

const args = process.argv.slice(2);
const idArg = args.find((a) => a.startsWith("--ids="));
const regenerate = args.includes("--regenerate");

const ids = idArg
  ? idArg.slice(6).split(",").map((s) => Number(s.trim())).filter(Boolean)
  : (await pool.query(`SELECT id FROM email_testing WHERE id BETWEEN 25 AND 34 ORDER BY id`)).rows.map((r) => r.id);

if (!ids.length) {
  console.error("No email_testing rows to follow up.");
  await pool.end();
  process.exit(1);
}

console.log(`Generating follow-ups for ${ids.length} thread(s)${regenerate ? " (regenerating)" : ""}\n`);

const results = [];
for (const [i, id] of ids.entries()) {
  process.stdout.write(`[${i + 1}/${ids.length}] email_testing #${id} ... `);
  const started = Date.now();
  try {
    const r = await runFollowupTest({ emailTestingId: id, steps: [1, 2], regenerate });
    if (r.error) {
      console.log(`ERROR: ${r.error}`);
      results.push({ id, status: "error", detail: r.error });
      continue;
    }
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    const ok = r.followups.filter((f) => f.valid).length;
    console.log(`${ok}/${r.followups.length} valid (${secs}s) — ${r.person} @ ${r.org}`);
    for (const f of r.followups) {
      const failed = Object.entries(f.validation || {}).filter(([, g]) => !g.pass).map(([n]) => n);
      results.push({
        thread: id,
        step: f.step,
        day: `+${f.send_after_days}d`,
        person: (r.person || "").slice(0, 16),
        words: String(f.body || "").trim().split(/\s+/).filter(Boolean).length,
        subject: (f.subject || "").slice(0, 40),
        status: f.valid ? "draft" : "rejected",
        detail: failed.join(",") || "",
      });
    }
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
    results.push({ id, status: "failed", detail: e.message });
  }
}

console.log("\n=== FOLLOW-UPS ===");
console.table(results);

const drafts = results.filter((r) => r.status === "draft").length;
const rejected = results.filter((r) => r.status === "rejected").length;
console.log(`\ndrafts ${drafts} · rejected ${rejected}`);
console.log(`All steps are in followup_testing. Nothing was sent.`);

await pool.end();
