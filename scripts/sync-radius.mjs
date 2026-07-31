// Refresh our own product row from radiusai.online.
//
//   npm run radius:sync
//
// Run this whenever the site copy changes. Every campaign and email built after
// it will pitch the product as the site currently describes it, rather than as
// someone remembered it.

import { syncRadiusProduct, RADIUS_URL } from "../src/lib/radiusProduct.js";
import { pool } from "../src/lib/db.js";

const url = process.argv[2] || RADIUS_URL;

const r = await syncRadiusProduct({ url });
if (r.error) {
  console.error(`✗ ${r.error}`);
  await pool.end();
  process.exit(1);
}

const p = r.product;
console.log(`✓ radius_product v${r.row.version} saved (id ${r.row.id}) from ${url}\n`);
console.log(`  name        ${p.name}`);
console.log(`  one_liner   ${p.one_liner}`);
console.log(`  category    ${p.category || "(none)"}`);
console.log(`  audience    ${p.audience.join(", ") || "(none)"}`);
console.log(`  pricing     ${p.pricing || "(not published)"}`);
console.log(`\n  capabilities (${p.capabilities.length}):`);
for (const c of p.capabilities) console.log(`    · ${c.name}: ${c.description}`);
console.log(`\n  value_props (${p.value_props.length}):`);
for (const c of p.value_props) console.log(`    · ${c.name}`);
console.log(`\n  offers (${p.offers.length}): ${p.offers.map((o) => o.name).join(", ") || "(none)"}`);

console.log(`\n  proof_points: ${p.proof_points.length}`);
if (p.proof_points.length === 0) {
  // Not a warning. The site publishes no statistics, and an email that invents
  // one is the failure this whole pipeline is built to prevent.
  console.log(`    (none — the site publishes no statistics, customers or testimonials.`);
  console.log(`     This is CORRECT. Do not hand-write proof into the DB; publish it first.)`);
}
if (r.quality.proof_points_rejected.length) {
  console.log(`    rejected as slogans, not proof: ${r.quality.proof_points_rejected.join(", ")}`);
}
if (r.quality.unsourced_facts) {
  console.log(`\n  ${r.quality.unsourced_facts} fact(s) demoted for citing an unfetched URL.`);
}

await pool.end();
