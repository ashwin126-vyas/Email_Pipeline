// Fill in `company_campaigns.research_notes` — this is what makes research_done
// mean something. For each company that has a website_url and no notes yet:
// fetch its site, summarise it with your AI provider, save the notes and set
// research_done = true.
//
//   npm run research:companies          # default: 5 companies
//   npm run research:companies 20       # do 20
//   npm run research:companies all      # every remaining company
//
// Costs one AI call + one page fetch per company, so it's batched on purpose.
// Safe to re-run: it only picks up companies that don't have notes yet.

import { pool } from "../src/lib/db.js";
import { fetchSiteText } from "../src/lib/siteText.js";
import { generateResearchNotes } from "../src/lib/generateSequence.js";

const arg = (process.argv[2] || "5").toLowerCase();
const limit = arg === "all" ? 10000 : parseInt(arg, 10) || 5;

try {
  const { rows: targets } = await pool.query(
    `SELECT DISTINCT ON (cam.company_id)
            cam.id AS tracker_id, cam.company_id, cam.company, cc.website_url
       FROM company_campaigns cam
       JOIN company_contacts cc ON cc.company_id = cam.company_id
      WHERE cam.research_notes IS NULL
        AND btrim(COALESCE(cc.website_url, '')) <> ''
      ORDER BY cam.company_id
      LIMIT $1`,
    [limit]
  );

  if (targets.length === 0) {
    console.log("Nothing to research — every company with a website already has notes.");
  } else {
    console.log(`Researching ${targets.length} company(ies)…\n`);
  }

  let ok = 0, failed = 0;
  for (const t of targets) {
    const label = (t.company || "").slice(0, 42).padEnd(42);
    const site = await fetchSiteText(t.website_url);
    if (site.error) {
      console.log(`  ✗ ${label} ${site.error}`);
      failed++;
      continue;
    }
    const res = await generateResearchNotes({ company: t.company, siteText: site.text });
    if (res.error) {
      console.log(`  ✗ ${label} ${res.error}`);
      failed++;
      continue;
    }
    // NB: research_done is NOT written here. It is derived from research_facts
    // passing the Tier 0 completeness check (schema.sql: refresh_research_done).
    // Notes alone are not research — `npm run facts:extract` is what earns the flag.
    await pool.query(
      `UPDATE company_campaigns
          SET research_notes = $1, updated_at = now()
        WHERE id = $2`,
      [res.notes, t.tracker_id]
    );
    console.log(`  ✓ ${label} ${res.notes.replace(/\s+/g, " ").slice(0, 60)}…`);
    ok++;
  }

  const { rows: left } = await pool.query(
    `SELECT count(*)::int AS done FROM company_campaigns WHERE research_notes IS NOT NULL`
  );
  console.log(`\nresearched ok: ${ok} | failed: ${failed} | total with notes: ${left[0].done}`);
} catch (e) {
  console.error("Research failed:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
