// Regenerate every current org campaign against the CURRENT radius_product.
//
//   npm run campaigns:refresh
//
// Campaigns cache one row per organisation and are only rebuilt when a contact at
// that org is generated with --refresh-campaign. That is right day to day, and
// wrong the moment the product itself changes: 21 campaigns were still carrying
// "Book a Free Demo Today" from a product row that listed one offer, while the
// current row lists four with routing rules. The email inherits the campaign's
// ask, so stale campaigns quietly override new product data.
//
// Does NOT touch radius_product.

import { pool } from "../src/lib/db.js";
import { currentRadiusProduct, productBlock } from "../src/lib/radiusProduct.js";
import { generateCampaign, saveCampaign } from "../src/lib/generateCampaign.js";
import { orgRowToBlock } from "../src/lib/personResearchStore.js";
import { synthesize } from "../src/lib/synthesize.js";
import { resetTokenLedger, tokenLedgerTotals } from "../src/lib/llm.js";

const FX = 95.48025;
const productRow = await currentRadiusProduct();
const product = productBlock(productRow);
console.log(`product v${productRow.version} (id ${productRow.id}) · ${product.offers.length} offers · ${product.proof_points.length} proof points\n`);

const { rows: campaigns } = await pool.query(
  `SELECT c.org_key, c.org_name, c.radius_product_id, c.org_research_id, c.input
     FROM radius_campaigns c WHERE c.is_current ORDER BY c.id`
);
const stale = campaigns.filter((c) => c.radius_product_id !== productRow.id);
console.log(`${campaigns.length} current campaigns · ${stale.length} built on an older product row\n`);

resetTokenLedger();
let done = 0, failed = 0;
for (const c of stale) {
  const { rows: orgRows } = await pool.query(
    `SELECT * FROM org_research WHERE lower(org_key)=lower($1) AND is_current LIMIT 1`, [c.org_key]
  );
  // Some early campaigns were keyed by org NAME before the key convention settled
  // on the website host, so their research row is gone. The campaign stores the
  // exact organisation block its prompt was built from, and every fact in it had
  // already cleared the citation floor — so rebuild from that rather than
  // re-crawling. The facts are unchanged; only the product is.
  let research, provenanceNote = "";
  if (orgRows[0]) {
    const org = orgRowToBlock(orgRows[0]);
    org.placement = orgRows[0].placement || null;
    research = synthesize({ mode: "to_person", person: {}, org, target: null, emailIntent: "", sourcesChecked: orgRows[0].sources_checked || 0 });
  } else {
    const prior = c.input?.organisation;
    if (!prior) { console.log(`skip ${c.org_key} — no research and no stored input`); failed++; continue; }
    research = {
      university: { name: prior.name, type: prior.type, location: prior.location,
        relevant_department: prior.department, placement: prior.placement || null },
      synthesis: { top_hooks: prior.hooks || [], shared_context: prior.shared_context || "" },
      provenance: (prior.facts || []).map((f) => ({ fact: f, confidence: 0.9 })),
    };
    provenanceNote = " (from stored input)";
  }

  const { rows: others } = await pool.query(
    `SELECT campaign_line FROM radius_campaigns
      WHERE is_current AND campaign_line IS NOT NULL AND lower(org_key) <> lower($1)
      ORDER BY created_at DESC LIMIT 15`, [c.org_key]
  );

  const result = await generateCampaign({
    product, research, orgName: c.org_name || c.org_key,
    recentLines: others.map((o) => o.campaign_line),
  });
  if (result?.error) { console.log(`✗ ${(c.org_name||c.org_key).slice(0,32)} — ${result.error}`); failed++; continue; }

  await saveCampaign({
    orgKey: c.org_key, orgName: c.org_name,
    orgResearchId: orgRows[0]?.id || c.org_research_id, productId: productRow.id, result,
  });
  done++;
  console.log(`✓ ${(c.org_name || c.org_key).slice(0, 30).padEnd(32)}${provenanceNote} ${String(result.campaign.campaign_line).slice(0, 32).padEnd(34)} ask: ${String(result.campaign.cta).slice(0, 40)}`);
}

const u = tokenLedgerTotals();
const cost = ((u.input / 1e6) * 2.50 + (u.output / 1e6) * 10.00) * FX;
console.log(`\n${done} regenerated · ${failed} skipped · ${u.calls} calls · ${(u.input + u.output).toLocaleString()} tokens · ₹${cost.toFixed(2)}`);
await pool.end();
