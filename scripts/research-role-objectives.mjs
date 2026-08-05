// Research what each placement role is actually measured on, and store it.
//
//   npm run roles:research          # research every role and save
//   npm run roles:research -- --list
//
// Replaces per-person research for these contacts. A placement officer's LinkedIn
// is behind an auth wall and their college page rarely says more than their name,
// so ~₹1.92 of person research per contact bought almost nothing. What actually
// differs between contacts is the ROLE — what it is judged on and what it can
// decide — and 377 contacts collapse to seven of those.
//
// Objectives are researched (search + crawl + extract) rather than written from
// imagination, and every one carries its sources. Same discipline as the rest of
// the pipeline: a claim we cannot source is a claim we do not make.

import { pool } from "../src/lib/db.js";
import { chatJSON, aiModel } from "../src/lib/llm.js";
import { multiSearch, searchEnabled, searchProvider } from "../src/lib/search.js";
import { crawlPages } from "../src/lib/researchCrawl.js";
import { currentRadiusProduct, productBlock } from "../src/lib/radiusProduct.js";

// Derived from the real distribution in prepare_data_one: 336 of 377 contacts are
// a Training & Placement Officer variant. Patterns are ordered by specificity —
// "assistant TPO" must match before plain "TPO".
const ROLES = [
  { role_key: "tpo_assistant", display_name: "Assistant / Deputy Training & Placement Officer",
    title_patterns: ["assistant.*(training|placement)", "asst\\.?.*(training|placement)", "deputy.*(training|placement)", "associate.*(training|placement)"],
    match_priority: 10, seniority: "assistant" },
  { role_key: "tpo_senior", display_name: "Senior / Central / Head of Training & Placement",
    title_patterns: ["(senior|sr\\.?|central|chief|head).*(training|placement)", "(head|director).*placement"],
    match_priority: 20, seniority: "senior" },
  { role_key: "faculty_tpo", display_name: "Faculty member holding the Placement Officer role",
    title_patterns: ["(professor|lecturer|faculty).*(training|placement)", "(training|placement).*(professor|lecturer)"],
    match_priority: 30, seniority: "officer" },
  { role_key: "placement_manager", display_name: "Placement Manager",
    title_patterns: ["placement manager", "manager.*placement"],
    match_priority: 40, seniority: "officer" },
  { role_key: "career_services", display_name: "Career Services",
    title_patterns: ["career services", "career development", "career cell"],
    match_priority: 50, seniority: "officer" },
  { role_key: "corporate_relations", display_name: "Corporate / Industry Relations",
    title_patterns: ["corporate relation", "industry relation", "industry interface", "outreach"],
    match_priority: 60, seniority: "officer" },
  { role_key: "tpo", display_name: "Training & Placement Officer",
    title_patterns: ["training.*placement", "placement officer", "\\btpo\\b", "t&p"],
    match_priority: 90, seniority: "officer" },
  { role_key: "other", display_name: "Other placement-adjacent role",
    title_patterns: [".*"], match_priority: 999, seniority: "officer" },
];

const SCHEMA = {
  type: "object",
  properties: {
    primary_objective: { type: "string", description: "One sentence: what this role is actually trying to achieve. Their goal, not their job description." },
    measured_on: { type: "array", items: { type: "string" }, description: "3-5 numbers or outcomes this role is judged by." },
    pain_points: { type: "array", items: { type: "string" }, description: "3-5 things that make the objective hard, as this person would describe them." },
    decision_power: { type: "string", description: "What this role can say yes to without asking anyone." },
    radius_angle: { type: "string", description: "Two sentences: how RadiusAI connects to THIS role's objective. Use only the listed capabilities. No statistics." },
    cta_style: { type: "string", description: "The ask that suits this role's authority — smaller for juniors." },
    tone_hint: { type: "string", description: "How to address this role." },
  },
  required: ["primary_objective", "measured_on", "pain_points", "decision_power", "radius_angle", "cta_style", "tone_hint"],
  additionalProperties: false,
};

const SYSTEM = `You profile a job role for B2C outreach in Indian higher education.

The product is RadiusAI: students use it to build ATS-compliant CVs, generate cover
letters, and track applications. STUDENTS are the customer. The person in this role
is a route to their students, not a buyer.

RULES
1. Output valid JSON only. No preamble, no markdown fences.
2. Ground everything in the SOURCE MATERIAL. Where it is silent, describe only what
   is genuinely typical of the role in Indian institutions — never invent a metric,
   a percentage, or a mandate that does not exist.
3. measured_on is what their PERFORMANCE is judged by, not their task list.
   "Placement percentage of the graduating batch" is a metric; "coordinating with
   companies" is a task.
4. radius_angle may only use capabilities in the product block. The product has NO
   statistics, NO named customers and NO pricing — do not imply any.
5. Match the ask to the authority. An assistant officer cannot commit the
   institution; a head of placements can take a meeting. Never propose procurement
   — nothing is being bought.
6. Write for a real person doing a hard job. No flattery, no "esteemed institution".`;

const run = async () => {
  const productRow = await currentRadiusProduct();
  const product = productBlock(productRow);
  console.log(`search provider: ${searchProvider() || "none"} | model: ${aiModel("gen")}\n`);

  for (const role of ROLES) {
    if (role.role_key === "other") continue; // filled from the tpo profile below
    const queries = [
      `"training and placement officer" responsibilities KPI India college`,
      `${role.display_name} role responsibilities Indian university placement cell`,
    ];
    let documents = [], snippets = [];
    if (searchEnabled()) {
      const s = await multiSearch(queries, { perQuery: 4 });
      const urls = [...new Set(s.results.map((r) => r.url))].slice(0, 4);
      const c = await crawlPages(urls, { limit: 4, kind: "search_result" });
      documents = c.documents || [];
      snippets = s.results.slice(0, 8);
    }

    const material = documents.length
      ? documents.map((d, i) => `[SOURCE ${i + 1}] url=${d.url}\n${d.text.slice(0, 6000)}`).join("\n\n---\n\n")
      : snippets.map((s, i) => `[SNIPPET ${i + 1}] url=${s.url}\n${s.title}\n${s.snippet}`).join("\n\n");

    const r = await chatJSON({
      system: SYSTEM,
      user: [
        `ROLE: ${role.display_name}`,
        `SENIORITY: ${role.seniority}`,
        ``,
        `PRODUCT (the only capabilities you may reference):`,
        JSON.stringify(product, null, 2),
        ``,
        `SOURCE MATERIAL`,
        material || "(no sources retrieved — describe only what is genuinely typical of the role)",
      ].join("\n"),
      schema: SCHEMA,
      schemaName: "role_objective",
      maxTokens: 1200,
      kind: "gen",
    });
    if (r.error) { console.log(`✗ ${role.role_key}: ${r.error}`); continue; }

    const v = r.value;
    await pool.query(`UPDATE role_objectives SET is_active = false WHERE role_key = $1`, [role.role_key]);
    await pool.query(
      `INSERT INTO role_objectives (role_key, display_name, title_patterns, match_priority, seniority,
         decision_power, primary_objective, measured_on, pain_points, radius_angle, cta_style, tone_hint,
         sources, research_output)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [role.role_key, role.display_name, role.title_patterns, role.match_priority, role.seniority,
       v.decision_power, v.primary_objective, v.measured_on, v.pain_points, v.radius_angle, v.cta_style,
       v.tone_hint, documents.map((d) => d.url), JSON.stringify(v)]
    );
    console.log(`✓ ${role.role_key.padEnd(19)} ${documents.length} sources · ${v.measured_on.length} metrics`);
    console.log(`    ${v.primary_objective}`);
  }

  // "other" inherits the TPO profile — it is the safe generic, and every contact
  // in this dataset is placement-adjacent.
  const { rows } = await pool.query(`SELECT * FROM role_objectives WHERE role_key='tpo' AND is_active`);
  if (rows[0]) {
    const t = rows[0];
    await pool.query(`UPDATE role_objectives SET is_active=false WHERE role_key='other'`);
    await pool.query(
      `INSERT INTO role_objectives (role_key, display_name, title_patterns, match_priority, seniority,
         decision_power, primary_objective, measured_on, pain_points, radius_angle, cta_style, tone_hint, sources, research_output)
       VALUES ('other','Other placement-adjacent role','{".*"}',999,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [t.seniority, t.decision_power, t.primary_objective, t.measured_on, t.pain_points,
       t.radius_angle, t.cta_style, t.tone_hint, t.sources, t.research_output]
    );
    console.log(`✓ other               (inherits the tpo profile)`);
  }
};

if (process.argv.includes("--list")) {
  const { rows } = await pool.query(
    `SELECT role_key, display_name, seniority, left(primary_objective, 90) objective
       FROM role_objectives WHERE is_active ORDER BY match_priority`
  );
  console.table(rows);
} else {
  await run();
}
await pool.end();
