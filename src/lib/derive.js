// derive() — EMAIL_GENERATION_CONTEXT.md §3. Runs after extract(), before
// generate(). Pure code: no LLM, deterministic, testable, logged.
//
// This is where personalisation actually comes from. Five templates plus a
// varying hook produces genuine differentiation; forty-nine free-form prompts
// produces forty-nine identical emails. The model improvises nothing about
// WHICH angle to take — it only writes the prose for the angle chosen here.

import { CONFIDENCE_FLOOR } from "./extractFacts.js";

export const SEGMENTS = ["group", "elite", "private_uni", "college", "non_engineering"];
export const PAINS = [
  "ats_rejection", "staff_bandwidth", "unreported_cohort",
  "tier2_recruiter_access", "accreditation_reporting",
];
export const PROOFS = ["es_london_pilot", "ats_uplift_stat", "dream2rank", "free_audit_only"];
export const OFFERS = ["free_ats_audit_50", "pilot_one_department", "group_licence_call"];

// Which proofs are substantiated TODAY. Per the honesty note in §7: the European
// School of Economics London pilot does not travel to a TPO in Jhansi, and the
// measured before/after ATS pass rate on real Indian student CVs does not exist
// yet. Until it does, the free audit is carrying the email. Add a proof here
// only when it survives scrutiny — derive() will start selecting it immediately.
export const PROOF_AVAILABLE = new Set(["free_audit_only"]);

// Preference order per segment. First entry that is in PROOF_AVAILABLE wins.
const PROOF_PREFERENCE = {
  group: ["ats_uplift_stat", "dream2rank", "free_audit_only"],
  elite: ["ats_uplift_stat", "es_london_pilot", "free_audit_only"],
  private_uni: ["ats_uplift_stat", "dream2rank", "free_audit_only"],
  college: ["ats_uplift_stat", "free_audit_only"],
  non_engineering: ["ats_uplift_stat", "free_audit_only"],
};

const MAX_HOOK_WORDS = 25;

/** Confidence for one field, from the provenance map. Absent = 0. */
export function confidenceOf(facts, field) {
  const p = facts?.provenance?.[field];
  const c = Number(p?.confidence);
  return Number.isFinite(c) ? c : 0;
}

/** May this fact be cited in an email? */
export function isCitable(facts, field) {
  return confidenceOf(facts, field) >= CONFIDENCE_FLOOR;
}

function deriveSegment(f) {
  if (f.campus_count > 1 || f.institution_type === "multi_campus_group") return "group";
  if (f.institution_type === "iit_nit_iiit" || f.institution_type === "central_university") return "elite";
  if (f.nirf_rank?.rank != null && f.nirf_rank.rank <= 100) return "elite";
  if (f.program_mix && !["engineering", "mixed"].includes(f.program_mix)) return "non_engineering";
  if (["private_university", "deemed_university"].includes(f.institution_type)) return "private_uni";
  return "college";
}

function derivePain(f, segment) {
  if (segment === "elite") return "ats_rejection";
  if (segment === "group" || f.annual_graduating_cohort > 2000) return "staff_bandwidth";
  const rate = f.claimed_placement_rate?.value;
  if (rate != null && rate < 70) return "unreported_cohort";
  if (f.city_tier != null && f.city_tier >= 2) return "tier2_recruiter_access";
  if (f.naac_grade && f.publishes_placement_report) return "accreditation_reporting";
  return "ats_rejection"; // the core product pain, and always defensible
}

function deriveProof(segment) {
  const pref = PROOF_PREFERENCE[segment] || ["free_audit_only"];
  return pref.find((p) => PROOF_AVAILABLE.has(p)) || "free_audit_only";
}

function deriveOffer(segment) {
  return segment === "group" ? "group_licence_call" : "free_ats_audit_50";
}

function trimWords(s, max) {
  const w = String(s).trim().split(/\s+/);
  return w.length <= max ? w.join(" ") : w.slice(0, max).join(" ");
}

/**
 * Build the hook. Prefers a dated recent_event; falls back to the specificity
 * anchor. Must be traceable to a source_url and clear the confidence floor —
 * an unciteable hook is no hook.
 */
function deriveHook(f) {
  const ev = f.recent_event;
  if (ev && ev.type !== "none_found" && ev.summary && isCitable(f, "recent_event")) {
    return {
      hook_sentence: trimWords(`${f.institution_name || "The institution"} recently ${ev.summary}`, MAX_HOOK_WORDS),
      hook_source: "recent_event",
      hook_source_url: ev.source_url || f.provenance?.recent_event?.source_url || null,
    };
  }
  if (f.specificity_anchor && isCitable(f, "specificity_anchor")) {
    return {
      hook_sentence: trimWords(f.specificity_anchor, MAX_HOOK_WORDS),
      hook_source: "specificity_anchor",
      hook_source_url: f.provenance?.specificity_anchor?.source_url || null,
    };
  }
  return { hook_sentence: null, hook_source: null, hook_source_url: null };
}

function deriveDealSize(f) {
  if (f.annual_graduating_cohort == null) return null;
  const total = f.annual_graduating_cohort * (f.campus_count || 1);
  if (total < 500) return "s";
  if (total < 1500) return "m";
  if (total < 4000) return "l";
  return "xl";
}

/**
 * Tier 0 gate + hook gate. Fail closed: a blocked email costs nothing, a bad
 * one costs the lead.
 * @returns {string[]} reasons this institution must not be emailed (empty = ok)
 */
export function blockReasons(f, hook) {
  const out = [];
  if (!f) return ["no research_facts row"];
  if (f.is_valid_buyer !== true) out.push(`not a buyer: ${f.invalid_reason || "no placement function"}`);
  if (!f.institution_name) out.push("missing institution_name");
  if (!f.institution_type) out.push("missing institution_type");
  if (!f.program_mix) out.push("missing program_mix");
  if (!f.contact_name) out.push("missing contact_name (never write 'Dear Sir/Madam')");
  if (!f.contact_title) out.push("missing contact_title");
  if (!f.contact_email) out.push("missing contact_email");
  if (!hook?.hook_sentence) out.push("no hook — an email with no hook is worse than no email");
  return out;
}

/**
 * Compute every derived field for one research_facts row.
 * @param {object} facts a research_facts row (provenance as an object)
 * @returns {{derived: object, blocked: string[], sendable: boolean}}
 */
export function derive(facts) {
  const f = facts || {};
  const segment_template = deriveSegment(f);
  const pain_hypothesis = derivePain(f, segment_template);
  const hook = deriveHook(f);
  const blocked = blockReasons(f, hook);

  return {
    derived: {
      segment_template,
      pain_hypothesis,
      proof_to_cite: deriveProof(segment_template),
      offer_variant: deriveOffer(segment_template),
      deal_size_band: deriveDealSize(f),
      ...hook,
    },
    blocked,
    sendable: blocked.length === 0,
  };
}

/**
 * The exact JSON contract handed to generate() (§4). Only citable facts survive
 * — this is the last point at which a low-confidence number can be dropped
 * before it reaches a real TPO.
 */
export function buildContract(facts, radiusBlock) {
  const f = facts;
  const { derived, blocked, sendable } = derive(f);
  const cite = (field, value) => (value != null && isCitable(f, field) ? value : undefined);

  const research = {
    institution_name: f.institution_name,
    institution_type: f.institution_type,
    campus_count: f.campus_count ?? undefined,
    program_mix: f.program_mix,
    annual_graduating_cohort: cite("annual_graduating_cohort", f.annual_graduating_cohort),
    placement_cell_name: cite("placement_cell_name", f.placement_cell_name),
    contact_name: f.contact_name,
    contact_title: f.contact_title,
    role_type: f.role_type,
    claimed_placement_rate: cite("claimed_placement_rate", f.claimed_placement_rate),
    median_package_lpa: cite("median_package_lpa", f.median_package_lpa),
    highest_package_lpa: cite("highest_package_lpa", f.highest_package_lpa),
    top_recruiters: f.top_recruiters?.length ? cite("top_recruiters", f.top_recruiters) : undefined,
    tech_focus_signals: f.tech_focus_signals?.length ? cite("tech_focus_signals", f.tech_focus_signals) : undefined,
    existing_placement_tech: cite("existing_placement_tech", f.existing_placement_tech),
    naac_grade: cite("naac_grade", f.naac_grade),
    nirf_rank: cite("nirf_rank", f.nirf_rank),
    placement_season_window: cite("placement_season_window", f.placement_season_window),
  };
  // Drop undefined so the model never sees an empty key it might feel obliged to fill.
  for (const k of Object.keys(research)) if (research[k] === undefined) delete research[k];

  return { contract: { research, derived, radius_block: radiusBlock || null }, blocked, sendable };
}
