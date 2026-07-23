// Generate outreach emails — steps 5-6 of EMAIL_GENERATION_CONTEXT.md.
// Joins research_facts + company_contacts + company_campaigns, builds the §4
// contract, calls generate() (LLM #2), runs every validation gate, and writes
// the prompt + input + content + gate results to `email_generations`.
//
//   npm run email:generate              # 5 contacts that don't have a draft yet
//   npm run email:generate 20           # do 20
//   npm run email:generate all          # everyone sendable
//   npm run email:generate all --groups # multi-campus groups first (§10.7)
//   npm run email:generate --show 12    # print generation #12 in full
//
// NOTHING IS SENT. Every row lands as 'draft' (passed all gates) or 'rejected'
// (failed one). Sending stays a separate, explicit step.

import { pool } from "../src/lib/db.js";
import { aiProvider } from "../src/lib/llm.js";
import { signatureReady, SIGNATURE } from "../src/lib/radiusBlock.js";
import {
  loadContractFor, generateOutreachEmail, saveGeneration, recentBodies,
} from "../src/lib/generateOutreach.js";

const args = process.argv.slice(2);
const groupsFirst = args.includes("--groups");
const showIdx = args.indexOf("--show");

// ── --show: print one stored generation in full, then exit ──────────────────
if (showIdx !== -1) {
  const id = parseInt(args[showIdx + 1], 10);
  const { rows } = await pool.query(`SELECT * FROM email_generations WHERE id = $1`, [id]);
  if (!rows.length) { console.error(`No generation #${id}.`); process.exit(1); }
  const g = rows[0];
  console.log(`\n#${g.id}  ${g.company}  ->  ${g.contact_name} <${g.contact_email}>`);
  console.log(`status: ${g.status}   segment: ${g.segment_template}   pain: ${g.pain_hypothesis}   offer: ${g.offer_variant}`);
  console.log(`hook: ${g.hook_sentence}`);
  console.log(`\n─── SUBJECT ───\n${g.subject}`);
  console.log(`\n─── BODY ───\n${g.body}`);
  console.log(`\n─── FACTS CITED ───\n${(g.facts_cited || []).join(", ") || "(none)"}`);
  console.log(`\n─── GATES ───`);
  for (const [name, r] of Object.entries(g.validation || {})) {
    console.log(`  ${r.pass ? "✓" : "✗"} ${name.padEnd(20)} ${r.detail || ""}`);
  }
  console.log(`\n─── INPUT CONTRACT (what the model actually saw) ───`);
  console.log(JSON.stringify(g.input_contract, null, 2));
  await pool.end();
  process.exit(0);
}

const arg = (args.find((a) => !a.startsWith("--") ) || "5").toLowerCase();
const limit = arg === "all" ? 10000 : parseInt(arg, 10) || 5;

if (!aiProvider()) {
  console.error("No AI key set. Add OPENAI_API_KEY (or ANTHROPIC_API_KEY) to .env.");
  process.exit(1);
}
if (!signatureReady()) {
  console.log("⚠  OUTREACH_SENDER_NAME is not set in .env, so emails will be generated");
  console.log("   without a sign-off. Set OUTREACH_SENDER_NAME / _CREDENTIAL / _WHY");
  console.log("   before sending anything. Generating anyway (nothing is sent).\n");
}

try {
  // Every contact whose company has current, Tier-0-complete facts and no draft yet.
  const { rows: targets } = await pool.query(
    `SELECT cc.id, cc.person, cc.company
       FROM company_contacts cc
       JOIN research_facts rf ON rf.company_id = cc.company_id AND rf.is_current
      WHERE rf.tier0_complete AND rf.is_valid_buyer
        AND NOT EXISTS (SELECT 1 FROM email_generations g
                         WHERE g.company_contact_id = cc.id AND g.status <> 'failed')
      ORDER BY ${groupsFirst ? `(rf.institution_type = 'multi_campus_group' OR rf.campus_count > 1) DESC,` : ""}
               cc.company_id, cc.id
      LIMIT $1`,
    [limit]
  );

  if (targets.length === 0) {
    console.log("Nothing to generate — every eligible contact already has a draft.");
  } else {
    console.log(`Generating ${targets.length} email(s) via ${aiProvider()}…\n`);
  }

  const prior = await recentBodies(pool, 50);
  let ok = 0, rejected = 0, failed = 0, blocked = 0;

  for (const t of targets) {
    const label = `${(t.company || "").slice(0, 30).padEnd(30)} ${(t.person || "").slice(0, 18).padEnd(18)}`;
    const loaded = await loadContractFor(pool, { contactId: t.id });
    if (loaded.error) { console.log(`  ✗ ${label} ${loaded.error}`); failed++; continue; }
    if (!loaded.sendable) {
      console.log(`  ⊘ ${label} blocked: ${loaded.blocked.join("; ").slice(0, 60)}`);
      blocked++;
      continue;
    }

    const result = await generateOutreachEmail({
      contract: loaded.contract,
      facts: loaded.facts,
      recentBodies: prior,
    });
    const id = await saveGeneration(pool, {
      meta: loaded.meta, contract: loaded.contract, prompts: result.prompts, result,
    });

    if (result.error) { console.log(`  ✗ ${label} ${result.error}`); failed++; continue; }
    prior.unshift(result.body);

    if (result.validation.valid) {
      console.log(`  ✓ #${String(id).padEnd(4)} ${label} ${result.subject}`);
      ok++;
    } else {
      console.log(`  ✗ #${String(id).padEnd(4)} ${label} REJECTED: ${result.validation.failed.join(", ")}`);
      rejected++;
    }
  }

  console.log(`\npassed: ${ok} | rejected by gates: ${rejected} | blocked pre-send: ${blocked} | errors: ${failed}`);

  const { rows: gateStats } = await pool.query(
    `SELECT key AS gate, count(*) FILTER (WHERE (value->>'pass')::boolean IS FALSE)::int AS failures
       FROM email_generations, jsonb_each(validation)
      WHERE subject IS NOT NULL
      GROUP BY key ORDER BY failures DESC, gate`
  );
  if (gateStats.length) {
    console.log(`\ngate failures across all generations:`);
    for (const g of gateStats) console.log(`  ${g.gate.padEnd(20)} ${g.failures}`);
  }
  console.log(`\nInspect one:  npm run email:generate -- --show <id>`);
  if (!signatureReady()) console.log(`Sign-off is empty — set OUTREACH_SENDER_NAME before sending.`);
} catch (e) {
  console.error("Generation failed:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
