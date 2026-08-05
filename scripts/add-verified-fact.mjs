// Record a fact a human vouches for, for one organisation.
//
//   npm run facts:add -- --org=avantikauniversity.edu.in --by="Ashwin" \
//     --fact="TCS, Infosys, Accenture, HCL and Paytm recruit from Avantika University."
//
// These are merged into the research contract at generation time and are subject
// to the same confidence floor as crawled facts. Use --list to review, --off=<id>
// to retire one that turns out to be wrong.
import { pool } from "../src/lib/db.js";

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || "").split("=").slice(1).join("=");
const org = arg("org"), fact = arg("fact"), by = arg("by") || "unknown";
const off = arg("off");

if (process.argv.includes("--list")) {
  const { rows } = await pool.query(
    `SELECT id, org_key, left(fact, 80) fact, confidence, added_by, is_active
       FROM verified_facts ${org ? "WHERE lower(org_key)=lower($1)" : ""} ORDER BY id`,
    org ? [org] : []
  );
  console.table(rows);
} else if (off) {
  await pool.query(`UPDATE verified_facts SET is_active=false WHERE id=$1`, [Number(off)]);
  console.log(`retired verified fact ${off}`);
} else if (org && fact) {
  const { rows } = await pool.query(
    `INSERT INTO verified_facts (org_key, fact, source_url, confidence, added_by, note)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [org, fact, arg("url") || null, Number(arg("confidence")) || 0.9, by, arg("note") || null]
  );
  console.log(`✓ verified fact ${rows[0].id} recorded for ${org}`);
  console.log(`  "${fact}"`);
  console.log(`  vouched for by: ${by}`);
} else {
  console.error("usage: --org=<key> --fact=\"…\" [--by=…] [--url=…] [--confidence=0.9] | --list | --off=<id>");
  process.exitCode = 1;
}
await pool.end();
