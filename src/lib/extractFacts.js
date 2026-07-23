// extract() — LLM call #1 of the outreach pipeline (EMAIL_GENERATION_CONTEXT.md §5).
//
// Turns messy source material (research notes, scraped homepage, placement page)
// into ONE typed `research_facts` row. This is the wall that keeps raw prose out
// of the generation prompt: generate() never sees notes, only these fields.
//
// The model is instructed to output null rather than guess. A null is a correct
// answer here — a wrong placement percentage sent to the person who owns that
// number destroys the lead permanently.
//
// Contact identity (name/title/email) is NOT taken from the model. Those come
// from company_contacts, which holds real people. The model only classifies
// role_type from the title it is shown.

import { chatJSON } from "./llm.js";

export const INSTITUTION_TYPES = [
  "iit_nit_iiit", "central_university", "private_university", "deemed_university",
  "autonomous_college", "affiliated_college", "multi_campus_group", "polytechnic", "non_academic",
];
export const PROGRAM_MIXES = ["engineering", "pharmacy", "management", "arts_science", "design", "mixed"];
export const ROLE_TYPES = [
  "tpo_head", "tpo_coordinator", "dean_placements", "director_principal",
  "corporate_relations", "faculty", "unknown",
];
export const EVENT_TYPES = [
  "mou_industry", "new_ai_or_tech_centre", "ranking_or_accreditation",
  "placement_drive_announcement", "hackathon_or_workshop", "new_program_launch",
  "leadership_change", "milestone_anniversary", "none_found",
];
export const TECH_SIGNALS = ["ai", "data_science", "cyber_security", "cloud", "iot", "robotics", "none"];

// Facts at or above this confidence may be cited in an email. Anything lower is
// stored for audit but withheld from the generator.
export const CONFIDENCE_FLOOR = 0.8;

// Nullable helpers — OpenAI strict mode needs a type union, not `nullable: true`.
const nstr = (d) => ({ type: ["string", "null"], description: d });
const nint = (d) => ({ type: ["integer", "null"], description: d });
const nnum = (d) => ({ type: ["number", "null"], description: d });
const nbool = (d) => ({ type: ["boolean", "null"], description: d });
const nenum = (values, d) => ({ type: ["string", "null"], enum: [...values, null], description: d });
const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const FACTS_SCHEMA = obj({
  // ── Tier 0 ──────────────────────────────────────────────────────────────
  institution_name: nstr("Official name as written on their own site."),
  is_valid_buyer: { type: "boolean", description: "False for training companies, ed-tech vendors, consultancies — anything with no student placement function." },
  invalid_reason: nstr("Why not a buyer. Null when is_valid_buyer is true."),
  institution_type: nenum(INSTITUTION_TYPES, "Drives which email template is used."),
  campus_count: nint("Number of campuses. Null unless stated."),
  program_mix: nenum(PROGRAM_MIXES, "Dominant program area."),
  annual_graduating_cohort: nint("Students graduating per year. Null unless stated."),
  role_type: nenum(ROLE_TYPES, "Classify from the contact title supplied in the source material."),

  // ── Tier 1: the hook ────────────────────────────────────────────────────
  recent_event: obj({
    type: { type: "string", enum: EVENT_TYPES },
    summary: nstr("One clause, e.g. 'signed an MOU with Bajaj Auto Foundation'."),
    date: nstr("ISO date YYYY-MM-DD. Must be within the last 12 months."),
    source_url: nstr("Where this was stated."),
    confidence: nnum("0.0-1.0"),
  }),
  placement_season_window: nstr("e.g. 'Aug 2026 - Dec 2026'. Null unless stated."),
  placement_cell_name: nstr("Their internal name for the team, e.g. 'Corporate Relations Cell'."),
  specificity_anchor: nstr("ONE verifiable detail that would not appear in a description of a different institution."),

  // ── Tier 2: the pitch surface ───────────────────────────────────────────
  claimed_placement_rate: {
    type: ["object", "null"],
    properties: {
      value: nnum("Percentage, e.g. 92.0"),
      year: nint(""),
      source_url: nstr(""),
      confidence: nnum("0.0-1.0"),
    },
    required: ["value", "year", "source_url", "confidence"],
    additionalProperties: false,
  },
  median_package_lpa: nnum("Lakhs per annum."),
  highest_package_lpa: nnum("Lakhs per annum."),
  top_recruiters: { type: "array", items: { type: "string" }, description: "Max 5, named on their site." },
  publishes_placement_report: nbool("Do they publish a placement report?"),
  placement_report_url: nstr(""),
  existing_placement_tech: nstr("Named placement/CV tool they already use, e.g. 'Superset'."),
  nirf_rank: {
    type: ["object", "null"],
    properties: { rank: nint(""), category: nstr(""), year: nint("") },
    required: ["rank", "category", "year"],
    additionalProperties: false,
  },
  naac_grade: nstr("e.g. 'A++'."),
  tech_focus_signals: { type: "array", items: { type: "string", enum: TECH_SIGNALS } },

  // ── Provenance ──────────────────────────────────────────────────────────
  // An array (not a map) because strict mode forbids arbitrary object keys.
  provenance: {
    type: "array",
    description: "One entry per Tier 1/Tier 2 field you filled in.",
    items: obj({
      field: { type: "string", description: "The field name this backs." },
      source_url: nstr(""),
      confidence: { type: "number", description: "0.0-1.0. Below 0.8 means it will not be used." },
    }),
  },
});

const SYSTEM = `You extract structured facts about an educational institution from source material.

RULES
1. Output valid JSON only. No preamble, no markdown fences, no commentary.
2. Never infer, estimate, or fill a field from general knowledge. If the source
   material does not state it, output null.
3. Every Tier 1 and Tier 2 fact must carry source_url and confidence (0.0-1.0).
   confidence < ${CONFIDENCE_FLOOR} means the fact will not be used. That is the correct outcome
   for anything uncertain.
4. Numbers are the highest-risk field. A wrong placement percentage sent to the
   person who owns that number destroys the lead permanently. When a number is
   ambiguous, output null.
5. recent_event must be dated within the last 12 months and carry a source_url.
   If nothing qualifies, set type to "none_found".
6. specificity_anchor must be a single verifiable detail that would not appear in
   a description of a different institution. "Focuses on placements" fails this
   test. "16,000+ alumni across 40 countries" passes.
7. Set is_valid_buyer to false when the organisation has no student placement
   function (training companies, ed-tech vendors, consultancies) and state why.`;

const clamp = (v, allowed) => (allowed.includes(v) ? v : null);

/**
 * Extract typed research facts for one institution.
 * @param {object} a
 * @param {string} a.company          company name (fallback for institution_name)
 * @param {string} a.sourceMaterial   research notes + scraped page text
 * @param {object} [a.contact]        { name, title, email } from company_contacts
 * @returns {Promise<{facts?: object, error?: string}>}
 */
export async function extractResearchFacts({ company, sourceMaterial, contact }) {
  if (!sourceMaterial || !sourceMaterial.trim()) {
    return { error: "No source material to extract from." };
  }
  const c = contact || {};
  const user = [
    `ORGANISATION: ${company || "(unknown)"}`,
    c.title ? `KNOWN CONTACT TITLE (classify role_type from this): ${c.title}` : ``,
    ``,
    `SOURCE MATERIAL`,
    sourceMaterial.trim().slice(0, 16000),
  ].filter(Boolean).join("\n");

  const r = await chatJSON({
    system: SYSTEM,
    user,
    schema: FACTS_SCHEMA,
    schemaName: "research_facts",
    maxTokens: 2000,
    kind: "gen",
  });
  if (r.error) return { error: r.error };
  const v = r.value;
  if (!v || typeof v !== "object") return { error: "The model returned no facts." };

  // Provenance array -> map, keeping only the highest confidence per field.
  const provenance = {};
  for (const p of Array.isArray(v.provenance) ? v.provenance : []) {
    if (!p?.field) continue;
    const conf = Number(p.confidence);
    const prev = provenance[p.field];
    if (prev && prev.confidence >= conf) continue;
    provenance[p.field] = {
      source_url: p.source_url || null,
      confidence: Number.isFinite(conf) ? Math.min(Math.max(conf, 0), 1) : 0,
      fetched_at: new Date().toISOString(),
    };
  }

  const event = v.recent_event || {};
  const facts = {
    // Tier 0 — contact identity is authoritative from the DB, never the model.
    institution_name: v.institution_name || company || null,
    is_valid_buyer: v.is_valid_buyer === true,
    invalid_reason: v.is_valid_buyer === true ? null : v.invalid_reason || null,
    institution_type: clamp(v.institution_type, INSTITUTION_TYPES),
    campus_count: Number.isFinite(v.campus_count) ? v.campus_count : null,
    program_mix: clamp(v.program_mix, PROGRAM_MIXES),
    annual_graduating_cohort: Number.isFinite(v.annual_graduating_cohort) ? v.annual_graduating_cohort : null,
    contact_name: c.name || null,
    contact_title: c.title || null,
    contact_email: c.email || null,
    role_type: clamp(v.role_type, ROLE_TYPES),

    // Tier 1
    recent_event: clamp(event.type, EVENT_TYPES) && event.type !== "none_found"
      ? { type: event.type, summary: event.summary || null, date: event.date || null, source_url: event.source_url || null }
      : { type: "none_found", summary: null, date: null, source_url: null },
    placement_season_window: v.placement_season_window || null,
    placement_cell_name: v.placement_cell_name || null,
    specificity_anchor: v.specificity_anchor || null,

    // Tier 2
    claimed_placement_rate: v.claimed_placement_rate?.value != null ? v.claimed_placement_rate : null,
    median_package_lpa: Number.isFinite(v.median_package_lpa) ? v.median_package_lpa : null,
    highest_package_lpa: Number.isFinite(v.highest_package_lpa) ? v.highest_package_lpa : null,
    top_recruiters: (Array.isArray(v.top_recruiters) ? v.top_recruiters : []).filter(Boolean).slice(0, 5),
    publishes_placement_report: typeof v.publishes_placement_report === "boolean" ? v.publishes_placement_report : null,
    placement_report_url: v.placement_report_url || null,
    existing_placement_tech: v.existing_placement_tech || null,
    nirf_rank: v.nirf_rank?.rank != null ? v.nirf_rank : null,
    naac_grade: v.naac_grade || null,
    tech_focus_signals: (Array.isArray(v.tech_focus_signals) ? v.tech_focus_signals : [])
      .filter((s) => TECH_SIGNALS.includes(s) && s !== "none"),
    provenance,
  };
  return { facts };
}

/**
 * Persist a facts row as the new current version, retiring the previous one.
 * The research_facts trigger recomputes company_campaigns.research_done.
 * @returns {Promise<number>} the new row id
 */
export async function saveResearchFacts(pool, { companyId, facts, sourceMaterial, model }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: prev } = await client.query(
      `SELECT COALESCE(max(version), 0) AS v FROM research_facts WHERE company_id = $1`,
      [companyId]
    );
    await client.query(
      `UPDATE research_facts SET is_current = false WHERE company_id = $1 AND is_current`,
      [companyId]
    );
    const { rows } = await client.query(
      `INSERT INTO research_facts (
         company_id, version, is_current,
         institution_name, is_valid_buyer, invalid_reason, institution_type,
         campus_count, program_mix, annual_graduating_cohort,
         contact_name, contact_title, contact_email, role_type,
         recent_event, placement_season_window, placement_cell_name, specificity_anchor,
         claimed_placement_rate, median_package_lpa, highest_package_lpa, top_recruiters,
         publishes_placement_report, placement_report_url, existing_placement_tech,
         nirf_rank, naac_grade, tech_focus_signals,
         provenance, extraction_model, source_material)
       VALUES ($1,$2,true,
               $3,$4,$5,$6,
               $7,$8,$9,
               $10,$11,$12,$13,
               $14,$15,$16,$17,
               $18,$19,$20,$21,
               $22,$23,$24,
               $25,$26,$27,
               $28,$29,$30)
       RETURNING id`,
      [
        companyId, Number(prev[0].v) + 1,
        facts.institution_name, facts.is_valid_buyer, facts.invalid_reason, facts.institution_type,
        facts.campus_count, facts.program_mix, facts.annual_graduating_cohort,
        facts.contact_name, facts.contact_title, facts.contact_email, facts.role_type,
        JSON.stringify(facts.recent_event), facts.placement_season_window, facts.placement_cell_name, facts.specificity_anchor,
        facts.claimed_placement_rate ? JSON.stringify(facts.claimed_placement_rate) : null,
        facts.median_package_lpa, facts.highest_package_lpa, facts.top_recruiters,
        facts.publishes_placement_report, facts.placement_report_url, facts.existing_placement_tech,
        facts.nirf_rank ? JSON.stringify(facts.nirf_rank) : null, facts.naac_grade, facts.tech_focus_signals,
        JSON.stringify(facts.provenance || {}), model || null, (sourceMaterial || "").slice(0, 20000),
      ]
    );
    await client.query("COMMIT");
    return rows[0].id;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
