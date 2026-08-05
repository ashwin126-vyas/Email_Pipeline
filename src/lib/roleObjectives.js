// Title -> role objective. The cached substitute for per-person research.
//
// 377 contacts carry 60 distinct titles, but 336 of them are a Training &
// Placement Officer variant differing only in spelling ("training and placement
// officer", "training & placement officer", "asst. T&P officer"). What varies
// between contacts is not the person, it is the ROLE — what it is measured on and
// what it can decide — so the role is researched once and read forever.

import { pool } from "./db.js";

let cache = null;

/** All active role rows, ordered most-specific first. Loaded once per process. */
export async function loadRoles() {
  if (cache) return cache;
  const { rows } = await pool.query(
    `SELECT * FROM role_objectives WHERE is_active ORDER BY match_priority ASC`
  );
  cache = rows;
  return rows;
}

export function clearRoleCache() { cache = null; }

/**
 * Match a job title to its role row. Specificity wins: "assistant training and
 * placement officer" must resolve to tpo_assistant, not tpo, because the ask that
 * suits an assistant is not the ask that suits the officer who can decide.
 */
export async function roleForTitle(title) {
  const roles = await loadRoles();
  const t = String(title || "").toLowerCase().trim();
  if (!t) return roles.find((r) => r.role_key === "other") || null;

  for (const role of roles) {
    for (const pattern of role.title_patterns || []) {
      try {
        if (new RegExp(pattern, "i").test(t)) return role;
      } catch { /* a bad pattern must not take the pipeline down */ }
    }
  }
  return roles.find((r) => r.role_key === "other") || null;
}

/** Row -> the compact block the email contract consumes. */
export function roleBlock(role) {
  if (!role) return null;
  return {
    role: role.display_name,
    seniority: role.seniority,
    objective: role.primary_objective,
    measured_on: role.measured_on || [],
    pain_points: role.pain_points || [],
    decision_power: role.decision_power,
    angle: role.radius_angle,
    suggested_ask: role.cta_style,
  };
}
