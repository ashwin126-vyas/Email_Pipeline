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
    description:
      "The INSTITUTION-WIDE placement rate the institution itself publishes. A single row from a per-department table is NOT this — output null instead.",
    properties: {
      value: nnum("Percentage, e.g. 92.0"),
      year: nint(""),
      basis: {
        type: ["string", "null"],
        enum: ["institution_wide", "single_department", "single_programme", "unclear", null],
        description: "What population the figure covers. Only institution_wide is usable.",
      },
      cohort_size: nint("Number of students the figure is calculated over, if stated."),
      source_url: nstr(""),
      confidence: nnum("0.0-1.0"),
    },
    required: ["value", "year", "basis", "cohort_size", "source_url", "confidence"],
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

  // ── Entity guard ────────────────────────────────────────────────────────
  is_multi_institution_trust: nbool(
    "True when this website covers SEVERAL institutions under one trust or group (e.g. an engineering college plus a homoeopathy, nursing or ayurveda college)."),
  sibling_institutions: {
    type: "array",
    items: { type: "string" },
    description: "Other institutions on this site that are NOT the target institution. Empty when the site covers only the target.",
  },

  // ── Provenance ──────────────────────────────────────────────────────────
  // An array (not a map) because strict mode forbids arbitrary object keys.
  provenance: {
    type: "array",
    description: "One entry per Tier 1/Tier 2 field you filled in.",
    items: obj({
      field: { type: "string", description: "The field name this backs." },
      source_url: nstr("MUST be copied exactly from the [SOURCE n] url= line the fact came from."),
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
   function (training companies, ed-tech vendors, consultancies) and state why.
8. SOURCES. The material is a series of [SOURCE n] blocks, each with a url= line.
   Every source_url you output must be copied EXACTLY from one of those url=
   lines. Never invent a URL, never guess one, never leave it null for a Tier 1
   or Tier 2 fact. A fact whose source_url is not one of the given URLs is
   discarded by code, so an unsourced fact is a wasted one.
9. ONE INSTITUTION ONLY. You are extracting facts about the TARGET INSTITUTION
   named below and nothing else. Many of these websites belong to a trust that
   also runs a homoeopathy, nursing, ayurveda, pharmacy or law college. Those are
   SIBLINGS, not the target. An accreditation, ranking or achievement belonging
   to a sibling must NEVER be recorded as the target's. List the siblings you
   see in sibling_institutions and set is_multi_institution_trust accordingly.
   If a fact could belong to either, output null. Attributing a sibling's
   accreditation to the target destroys the lead.
10. PLACEMENT TABLES. These sites usually publish placement figures broken down
   BY DEPARTMENT and BY YEAR. A single row of such a table is not the
   institution's placement rate. "CIVIL 2 registered, 2 placed, 100%" is a
   two-student department, and quoting it back as "your 100% placement rate"
   tells the reader you did not understand their own data. Only record
   claimed_placement_rate when the institution states ONE figure for the whole
   institution, and set basis accordingly. When you only have a per-department
   table, output null. The same applies to package figures: prefer the number
   the institution headlines, not the largest one you can find.
11. SPECIFICITY. "Affiliated to GTU", "approved by AICTE" and "NAAC accredited"
   are true of hundreds of institutions and are NOT specificity anchors. The
   anchor must be something that would be false of every other institution.`;

const clamp = (v, allowed) => (allowed.includes(v) ? v : null);

// Routing/classification fields. These decide which template is used, are never
// quoted in an email, and so do not need a citable source.
const ROUTING_FIELDS = new Set([
  "institution_name", "institution_type", "program_mix", "role_type",
  "is_valid_buyer", "invalid_reason", "campus_count",
  "contact_name", "contact_title", "contact_email",
]);

// Disciplines that identify a sibling college inside a trust.
const DISCIPLINES = [
  "homoeopathy", "homeopathy", "ayurved", "ayurveda", "unani", "naturopathy",
  "nursing", "dental", "medical", "physiotherapy", "law", "polytechnic",
];

/**
 * Everything a model asserted but could not source is demoted below the
 * confidence floor here, in code. Instructions are a request; this is the rule.
 *
 * @param {object} facts       mutated in place
 * @param {Set<string>} allowedUrls  the URLs actually fetched
 * @returns {{demoted: string[], event_dropped: string|null, sibling_conflicts: string[]}}
 */
export function enforceSourcing(facts, allowedUrls) {
  const report = { demoted: [], event_dropped: null, sibling_conflicts: [] };
  const urls = allowedUrls instanceof Set ? allowedUrls : new Set(allowedUrls || []);

  for (const [field, p] of Object.entries(facts.provenance || {})) {
    if (ROUTING_FIELDS.has(field)) continue;
    const sourced = p?.source_url && urls.has(p.source_url);
    if (!sourced && Number(p?.confidence) >= CONFIDENCE_FLOOR) {
      // Stored for audit, but permanently below the floor, so buildContract()
      // will never hand it to the generator.
      p.confidence = 0.5;
      p.unsourced = true;
      report.demoted.push(field);
    }
  }

  // §2: a recent_event must be dated within 12 months AND carry a source.
  // Anything else is not an event, it is a sentence about the past.
  const ev = facts.recent_event;
  if (ev && ev.type && ev.type !== "none_found") {
    const sourced = ev.source_url && urls.has(ev.source_url);
    const dated = Boolean(ev.date);
    const fresh = dated && (Date.now() - new Date(ev.date).getTime()) < 400 * 24 * 3600 * 1000;
    if (!sourced || !dated || !fresh) {
      report.event_dropped = !dated ? "no date" : !sourced ? "unsourced" : "older than 12 months";
      facts.recent_event = { type: "none_found", summary: null, date: null, source_url: null };
    }
  }

  // Placement-rate discipline. A per-department row is not an institution's
  // placement rate, and "100%" is nearly always a tiny department. Citing it
  // back at the person who owns the real number is a lead-killer.
  const rate = facts.claimed_placement_rate;
  if (rate && rate.value != null) {
    const v = Number(rate.value);
    let reject = null;
    if (!Number.isFinite(v) || v < 0 || v > 100) reject = "out of range";
    else if (rate.basis && rate.basis !== "institution_wide") reject = `basis=${rate.basis}`;
    else if (!rate.basis || rate.basis === "unclear") reject = "basis unclear";
    else if (v >= 99.5 && (rate.cohort_size == null || rate.cohort_size < 50)) {
      reject = "100% over an unstated or tiny cohort";
    }
    if (reject) {
      report.rate_rejected = reject;
      facts.claimed_placement_rate = null;
      if (facts.provenance?.claimed_placement_rate) facts.provenance.claimed_placement_rate.confidence = 0;
    }
  }

  // Anchor specificity. "Affiliated to GTU" is true of hundreds of colleges, so
  // it proves nothing and reads as a mail merge.
  const GENERIC_ANCHOR = /affiliated\s+(to|with)|approved\s+by\s+(aicte|ugc|pci|bci|nba)|recognis?zed\s+by|iso\s*\d|committed\s+to|focus(es)?\s+on|state[- ]of[- ]the[- ]art|world[- ]class|holistic/i;
  const anchorText = String(facts.specificity_anchor || "");
  if (anchorText && GENERIC_ANCHOR.test(anchorText) && !/\d/.test(anchorText)) {
    report.anchor_rejected = "generic (affiliation/approval boilerplate, no distinguishing detail)";
    facts.specificity_anchor = null;
    if (facts.provenance?.specificity_anchor) facts.provenance.specificity_anchor.confidence = 0;
  }

  // Sibling guard: an anchor about the trust's homoeopathy college is not a fact
  // about the engineering college we are writing to.
  const siblings = Array.isArray(facts.sibling_institutions) ? facts.sibling_institutions : [];
  if (facts.is_multi_institution_trust || siblings.length) {
    const target = String(facts.institution_name || "").toLowerCase();
    const anchor = String(facts.specificity_anchor || "").toLowerCase();
    if (anchor) {
      const targetDiscipline = DISCIPLINES.filter((d) => target.includes(d));
      const anchorDiscipline = DISCIPLINES.filter((d) => anchor.includes(d));
      const conflict = anchorDiscipline.filter((d) => !targetDiscipline.includes(d));
      if (conflict.length) {
        report.sibling_conflicts.push(`anchor mentions ${conflict.join("/")}, target does not`);
        facts.specificity_anchor = null;
        if (facts.provenance?.specificity_anchor) facts.provenance.specificity_anchor.confidence = 0;
      }
    }
  }
  return report;
}

/**
 * Extract typed research facts for one institution.
 * @param {object} a
 * @param {string} a.company          company name (fallback for institution_name)
 * @param {Array<{url,text,kind}>} [a.documents] crawled pages — preferred input
 * @param {string} [a.sourceMaterial] fallback prose when there is no crawl
 * @param {object} [a.contact]        { name, title, email } from company_contacts
 * @returns {Promise<{facts?: object, quality?: object, error?: string}>}
 */
export async function extractResearchFacts({ company, documents, sourceMaterial, contact }) {
  const docs = Array.isArray(documents) ? documents : [];
  const material = docs.length
    ? docs.map((d, i) => `[SOURCE ${i + 1}] kind=${d.kind} url=${d.url}\n${d.text}`).join("\n\n---\n\n")
    : String(sourceMaterial || "");
  if (!material.trim()) return { error: "No source material to extract from." };
  const allowedUrls = new Set(docs.map((d) => d.url));

  const c = contact || {};
  const user = [
    `TARGET INSTITUTION: ${company || "(unknown)"}`,
    `Extract facts about THIS institution only. Other institutions appearing in`,
    `the sources are siblings under the same trust — list them, do not adopt`,
    `their achievements.`,
    c.title ? `\nKNOWN CONTACT TITLE (classify role_type from this): ${c.title}` : ``,
    docs.length
      ? `\nYou may cite ONLY these URLs:\n${docs.map((d, i) => `  [SOURCE ${i + 1}] ${d.url}`).join("\n")}`
      : `\nNo page URLs are available for this institution, so every Tier 1 and Tier 2\nfact must be given confidence below ${CONFIDENCE_FLOOR}.`,
    ``,
    `SOURCE MATERIAL`,
    material.slice(0, 60000),
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

    // Entity guard
    is_multi_institution_trust: typeof v.is_multi_institution_trust === "boolean" ? v.is_multi_institution_trust : null,
    sibling_institutions: (Array.isArray(v.sibling_institutions) ? v.sibling_institutions : []).filter(Boolean).slice(0, 12),

    provenance,
    source_urls: [...allowedUrls],
  };

  // Instructions are a request; this is the rule.
  const quality = enforceSourcing(facts, allowedUrls);
  return { facts, quality };
}

/**
 * Persist a facts row as the new current version, retiring the previous one.
 * The research_facts trigger recomputes company_campaigns.research_done.
 * @returns {Promise<number>} the new row id
 */
export async function saveResearchFacts(pool, { companyId, facts, sourceMaterial, model, quality }) {
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
         is_multi_institution_trust, sibling_institutions,
         provenance, extraction_model, source_material, source_urls, quality)
       VALUES ($1,$2,true,
               $3,$4,$5,$6,
               $7,$8,$9,
               $10,$11,$12,$13,
               $14,$15,$16,$17,
               $18,$19,$20,$21,
               $22,$23,$24,
               $25,$26,$27,
               $28,$29,
               $30,$31,$32,$33,$34)
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
        facts.is_multi_institution_trust, facts.sibling_institutions || [],
        JSON.stringify(facts.provenance || {}), model || null, (sourceMaterial || "").slice(0, 20000),
        facts.source_urls || [], JSON.stringify(quality || {}),
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
