// RadiusAI — OUR product data, extracted from our own site.
//
// The research pipeline goes to great lengths to make claims about THEM
// traceable. Claims about US get the same treatment, for the same reason: an
// email is read by someone who can open the page and check. Hand-writing the
// product copy into a prompt is how a pitch quietly drifts from what the product
// actually does.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE SITE ACTUALLY PUBLISHES (checked 2026-07-30)
//
// radiusai.online is a single page, ~950 characters. /features, /partner,
// /pricing and /about are all 404 — the nav links are on-page anchors. It states
// three capabilities (CV Builder, Cover Letter & Email Generator, Dashboard &
// Application Tracker), one positioning line ("The AI that gets students
// placed"), and four CTAs. It publishes:
//
//   · NO statistics          · NO named customers
//   · NO pricing             · NO testimonials
//
// So `proof_points` comes back EMPTY, and that is the correct state rather than
// a gap to paper over. "TRUSTED BY FUTURE CHANGE MAKERS AND INNOVATORS" is
// aspirational page furniture, not a customer list, and is deliberately not
// extracted as proof. Until a measured before/after ATS figure exists, the free
// demo carries the email — the same honesty note that governs radiusBlock.js.
// ─────────────────────────────────────────────────────────────────────────────

import { chatJSON, aiProvider, aiModel } from "./llm.js";
import { crawlPages } from "./researchCrawl.js";
import { pool } from "./db.js";

export const RADIUS_URL = process.env.RADIUS_SITE_URL || "https://www.radiusai.online/";

const nstr = (d) => ({ type: ["string", "null"], description: d });
const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const CLAIM = obj({
  name: { type: "string", description: "Short label." },
  description: { type: "string", description: "What the site says, close to its own words." },
  source_url: nstr("Copied exactly from a [SOURCE n] url= line."),
});

const PRODUCT_SCHEMA = obj({
  name: nstr("Product name as written."),
  one_liner: nstr("The site's own positioning line, quoted."),
  what_it_does: nstr("Two sentences maximum, using the site's own claims."),
  category: nstr("e.g. 'placement / careers software'."),
  audience: { type: "array", items: { type: "string" }, description: "Who the site says it is for." },
  capabilities: { type: "array", items: CLAIM, description: "Named features the site describes." },
  value_props: { type: "array", items: CLAIM, description: "Benefits the site claims. No numbers unless printed." },
  proof_points: {
    type: "array",
    items: CLAIM,
    description:
      "Statistics, named customers or testimonials. EMPTY unless the site prints a real one. Slogans such as 'trusted by future change makers' are NOT proof.",
  },
  differentiators: { type: "array", items: CLAIM, description: "Only if the site explicitly claims them." },
  offers: { type: "array", items: CLAIM, description: "Calls to action, e.g. 'Book a Free Demo'." },
  pricing: nstr("Null unless a price is printed."),
  compliance_notes: nstr("Data handling / privacy statements. Null if none."),
  facts: {
    type: "array",
    items: obj({
      fact: { type: "string", description: "One self-contained sentence about the product." },
      source_url: nstr("Copied exactly from a [SOURCE n] url= line."),
      confidence: { type: "number", description: "0.0-1.0" },
    }),
    description: "Every claim above, as citable sentences.",
  },
});

const SYSTEM = `You extract a structured product description from a company's own
marketing site, for use in cold outreach.

RULES
1. Output valid JSON only. No preamble, no markdown fences.
2. Record ONLY what the page states. Never add a capability, benefit, integration
   or customer from your own knowledge of similar products. If the page does not
   say it, it does not exist.
3. proof_points is for STATISTICS, NAMED CUSTOMERS and TESTIMONIALS only. Marketing
   slogans ("trusted by innovators", "loved by students") are not proof and must
   NOT go there. An empty proof_points array is a correct and expected answer.
4. Never invent a number. If the page prints no figures, output none. A fabricated
   statistic in a cold email is the single most damaging thing you can produce here.
5. Every source_url must be copied exactly from a [SOURCE n] url= line.
6. Keep the site's own words where you can. This is our own product and the
   phrasing is deliberate.`;

/**
 * Crawl our site and extract the product row.
 * @param {{url?: string}} [opts]
 * @returns {Promise<{product?: object, sources?: object, error?: string}>}
 */
export async function extractRadiusProduct({ url = RADIUS_URL } = {}) {
  const { documents, skipped } = await crawlPages([url], { limit: 3, kind: "product" });
  if (!documents.length) {
    return { error: `Could not read ${url}: ${skipped[0]?.reason || "no readable text"}` };
  }

  const material = documents
    .map((d, i) => `[SOURCE ${i + 1}] kind=${d.kind} url=${d.url}\n${d.text}`)
    .join("\n\n---\n\n");

  const r = await chatJSON({
    system: SYSTEM,
    user: [
      `PRODUCT SITE: ${url}`,
      ``,
      `You may cite ONLY these URLs:`,
      documents.map((d, i) => `  [SOURCE ${i + 1}] ${d.url}`).join("\n"),
      ``,
      `SOURCE MATERIAL`,
      material,
    ].join("\n"),
    schema: PRODUCT_SCHEMA,
    schemaName: "radius_product",
    maxTokens: 2000,
    kind: "gen",
  });
  if (r.error) return { error: r.error };

  const v = r.value || {};
  const allowed = new Set(documents.map((d) => d.url));

  // Same rule as the research side: a claim citing a page we did not fetch is an
  // assertion, not evidence. Applies to our own marketing too.
  const facts = (v.facts || [])
    .filter((f) => f?.fact)
    .map((f) => ({
      fact: f.fact,
      source_url: f.source_url && allowed.has(f.source_url) ? f.source_url : null,
      confidence: f.source_url && allowed.has(f.source_url) ? Math.min(Math.max(Number(f.confidence) || 0, 0), 1) : 0.5,
    }));

  const product = {
    name: v.name || "RadiusAI",
    url,
    one_liner: v.one_liner || null,
    what_it_does: v.what_it_does || null,
    category: v.category || null,
    audience: (v.audience || []).filter(Boolean).slice(0, 8),
    capabilities: (v.capabilities || []).slice(0, 10),
    value_props: (v.value_props || []).slice(0, 10),
    proof_points: (v.proof_points || []).slice(0, 10),
    differentiators: (v.differentiators || []).slice(0, 10),
    offers: (v.offers || []).slice(0, 8),
    pricing: v.pricing || null,
    compliance_notes: v.compliance_notes || null,
    facts,
    source_urls: [...allowed],
  };

  // Marketing slogans routinely arrive dressed as proof. Strip them in code —
  // the prompt asks, this enforces.
  const SLOGAN = /trusted by|loved by|change makers|innovators|world[- ]class|industry[- ]leading|best[- ]in[- ]class/i;
  const rejected = product.proof_points.filter((p) => SLOGAN.test(`${p.name} ${p.description}`));
  product.proof_points = product.proof_points.filter((p) => !SLOGAN.test(`${p.name} ${p.description}`));

  return {
    product,
    quality: {
      proof_points_rejected: rejected.map((p) => p.name),
      has_proof: product.proof_points.length > 0,
      unsourced_facts: facts.filter((f) => !f.source_url).length,
    },
    sources: { documents: documents.map((d) => ({ url: d.url })), fetched: documents.length },
  };
}

/** Persist as the new current version, retiring the previous one. */
export async function saveRadiusProduct({ product, quality, input }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: prev } = await client.query(`SELECT COALESCE(max(version), 0) AS v FROM radius_product`);
    await client.query(`UPDATE radius_product SET is_current = false WHERE is_current`);
    const { rows } = await client.query(
      `INSERT INTO radius_product (
         version, is_current, name, url, one_liner, what_it_does, category,
         audience, capabilities, value_props, proof_points, differentiators, offers,
         pricing, compliance_notes, provenance, source_urls,
         input, output, quality, provider, model)
       VALUES ($1,true,$2,$3,$4,$5,$6, $7,$8,$9,$10,$11,$12, $13,$14,$15,$16, $17,$18,$19,$20,$21)
       RETURNING *`,
      [
        Number(prev[0].v) + 1, product.name, product.url, product.one_liner, product.what_it_does, product.category,
        JSON.stringify(product.audience), JSON.stringify(product.capabilities),
        JSON.stringify(product.value_props), JSON.stringify(product.proof_points),
        JSON.stringify(product.differentiators), JSON.stringify(product.offers),
        product.pricing, product.compliance_notes,
        JSON.stringify(product.facts), product.source_urls,
        JSON.stringify(input || {}), JSON.stringify(product), JSON.stringify(quality || {}),
        aiProvider(), aiModel("gen"),
      ]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function currentRadiusProduct() {
  const { rows } = await pool.query(`SELECT * FROM radius_product WHERE is_current LIMIT 1`);
  return rows[0] || null;
}

/** Row -> the compact block the campaign and email prompts consume. */
export function productBlock(row) {
  if (!row) return null;
  const extra = row.output || {};
  return {
    name: row.name,
    url: row.url,
    one_liner: row.one_liner,
    what_it_does: row.what_it_does,
    audience: row.audience || [],
    capabilities: (row.capabilities || []).map((c) => ({ name: c.name, description: c.description })),
    value_props: (row.value_props || []).map((c) => ({ name: c.name, description: c.description })),
    // No longer empty. The pipeline was built around proof_available: "NONE";
    // there are now real, sourced proofs, so the campaign and email may cite them
    // — and no_orphan_numbers will accept their figures because they are in the
    // contract. Anything NOT here is still off limits.
    proof_points: (row.proof_points || []).map((c) => ({ fact: c.fact || c.name, source_url: c.source_url || null })),
    // best_for is the routing hint: which institution each offer suits.
    offers: (row.offers || []).map((c) => ({ name: c.name, description: c.description, best_for: c.best_for || null })),
    pricing: row.pricing || null,
    cta_selection_logic: extra.cta_selection_logic || null,
  };
}

/** Roadmap items that must never appear in an email — they do not exist yet. */
export function doNotCite(row) {
  return (row?.output?.DO_NOT_CITE_roadmap_only) || [];
}

/** Fetch-and-store in one call, used by `npm run radius:sync` and the API. */
export async function syncRadiusProduct({ url = RADIUS_URL, force = false } = {}) {
  // The current row may have been supplied by hand (data/radius_data.json) and be
  // far richer than anything the site publishes — the site has no pricing, no
  // proof points and three of the four capabilities. Re-crawling would silently
  // replace all of that with a thinner truth. Refuse unless explicitly forced.
  const current = await currentRadiusProduct();
  if (current?.quality?.hand_supplied && !force) {
    return {
      error:
        "The current radius_product row was supplied by hand and is richer than the site. " +
        "Re-crawling would discard pricing, proof points and capabilities the site does not publish. " +
        "Pass force:true to overwrite it deliberately.",
      row: current,
    };
  }
  const r = await extractRadiusProduct({ url });
  if (r.error) return { error: r.error };
  const row = await saveRadiusProduct({ product: r.product, quality: r.quality, input: { url } });
  return { row, product: r.product, quality: r.quality };
}
