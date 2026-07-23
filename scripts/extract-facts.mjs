// Build the typed `research_facts` rows — step 2 of the build order in
// EMAIL_GENERATION_CONTEXT.md. Runs extract() (LLM call #1) over the research
// notes we already have and stores one versioned row per company.
//
//   npm run facts:extract           # default: 5 companies without facts yet
//   npm run facts:extract 30        # do 30
//   npm run facts:extract all       # every company that has notes
//   npm run facts:extract all --refresh   # re-extract even where facts exist
//
// Costs one AI call per company, so it's batched on purpose. Safe to re-run:
// without --refresh it only picks up companies that have notes but no facts.
// Re-extracting never destroys history — the old row is kept as a prior version.

import { pool } from "../src/lib/db.js";
import { extractResearchFacts, saveResearchFacts, CONFIDENCE_FLOOR } from "../src/lib/extractFacts.js";
import { aiProvider } from "../src/lib/llm.js";

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const arg = (args.find((a) => !a.startsWith("--")) || "5").toLowerCase();
const limit = arg === "all" ? 10000 : parseInt(arg, 10) || 5;

const provider = aiProvider();
if (!provider) {
  console.error("No AI key set. Add OPENAI_API_KEY (or ANTHROPIC_API_KEY) to .env.");
  process.exit(1);
}

try {
  // One row per company: its notes plus its primary (first) real contact.
  const { rows: targets } = await pool.query(
    `SELECT DISTINCT ON (cam.company_id)
            cam.company_id, cam.company, cam.research_notes,
            cc.person AS contact_name, cc.title AS contact_title, cc.email AS contact_email
       FROM company_campaigns cam
       JOIN company_contacts cc ON cc.company_id = cam.company_id
      WHERE btrim(COALESCE(cam.research_notes, '')) <> ''
        ${refresh ? "" : `AND NOT EXISTS (SELECT 1 FROM research_facts rf
                                           WHERE rf.company_id = cam.company_id AND rf.is_current)`}
      ORDER BY cam.company_id, cc.id
      LIMIT $1`,
    [limit]
  );

  if (targets.length === 0) {
    console.log(refresh
      ? "No companies have research notes yet — run `npm run research:companies` first."
      : "Nothing to extract — every company with notes already has facts. Use --refresh to redo them.");
  } else {
    console.log(`Extracting facts for ${targets.length} company(ies) via ${provider}…\n`);
  }

  let ok = 0, failed = 0, blocked = 0, tier0 = 0;
  for (const t of targets) {
    const label = (t.company || "").slice(0, 38).padEnd(38);
    const { facts, error } = await extractResearchFacts({
      company: t.company,
      sourceMaterial: t.research_notes,
      contact: { name: t.contact_name, title: t.contact_title, email: t.contact_email },
    });
    if (error) {
      console.log(`  ✗ ${label} ${error}`);
      failed++;
      continue;
    }

    const id = await saveResearchFacts(pool, {
      companyId: t.company_id,
      facts,
      sourceMaterial: t.research_notes,
      model: provider,
    });
    const { rows: saved } = await pool.query(
      `SELECT tier0_complete FROM research_facts WHERE id = $1`, [id]
    );

    if (!facts.is_valid_buyer) {
      console.log(`  ⊘ ${label} NOT A BUYER — ${facts.invalid_reason || "no placement function"}`);
      blocked++;
      continue;
    }
    if (saved[0].tier0_complete) tier0++;

    const hook = facts.recent_event?.type !== "none_found"
      ? `event:${facts.recent_event.type}`
      : facts.specificity_anchor ? "anchor" : "NO HOOK";
    const cited = Object.values(facts.provenance).filter((p) => p.confidence >= CONFIDENCE_FLOOR).length;
    console.log(
      `  ✓ ${label} ${(facts.institution_type || "?").padEnd(20)} ${(facts.program_mix || "?").padEnd(13)}` +
      ` tier0:${saved[0].tier0_complete ? "Y" : "n"} ${hook.padEnd(28)} citable:${cited}`
    );
    ok++;
  }

  const { rows: summary } = await pool.query(
    `SELECT count(*)::int AS with_facts,
            count(*) FILTER (WHERE tier0_complete)::int AS tier0_ok,
            count(*) FILTER (WHERE NOT is_valid_buyer)::int AS not_buyers,
            count(*) FILTER (WHERE recent_event->>'type' <> 'none_found'
                                OR specificity_anchor IS NOT NULL)::int AS has_hook
       FROM research_facts WHERE is_current`
  );
  const s = summary[0];
  console.log(`\nextracted: ${ok} | not-a-buyer: ${blocked} | failed: ${failed}`);
  console.log(`research_facts (current): ${s.with_facts} | Tier 0 complete: ${s.tier0_ok} | has a hook: ${s.has_hook} | not buyers: ${s.not_buyers}`);
  console.log(`\nSendable today = Tier 0 complete AND has a hook. Everything else is blocked by design.`);
} catch (e) {
  console.error("Extraction failed:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
