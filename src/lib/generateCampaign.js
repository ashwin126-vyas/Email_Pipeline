// Campaign generation — the ORGANISATION-level layer.
//
// One campaign per university, shared by every contact there; the email
// underneath it is still written per person. That split is the whole point: a
// campaign is a single idea an institution receives consistently, and twenty-seven
// contacts at one college getting twenty-seven different pitches for the same
// product is not personalisation, it is incoherence.
//
// The brief is "Thanda Matlab Coca-Cola" — so the target is a LINE, not a slogan
// soup. What makes that line work, and what the gates below actually enforce:
//
//   · it is short (three words),
//   · it names the brand, so it cannot be reused by a competitor,
//   · it claims a CATEGORY ("thanda" = cold drinks) rather than a statistic,
//   · it is Indian-market native — Hinglish, spoken, not translated.
//
// The category claim is the important one for us: radiusai.online publishes no
// statistics, no customers and no pricing, so a line that leans on proof would
// have to invent it. A category line needs no numbers, which is exactly why it
// suits a product whose proof_points array is legitimately empty.

import { chatJSON, aiProvider } from "./llm.js";
import { pool } from "./db.js";

export const CAMPAIGN_PROMPT_VERSION = "campaign-v1-2026-07";

const MAX_LINE_WORDS = 6;

const CAMPAIGN_SCHEMA = {
  type: "object",
  properties: {
    campaign_line: { type: "string", description: `The line. Max ${MAX_LINE_WORDS} words. MUST contain the product name.` },
    line_meaning: { type: "string", description: "Plain-English gloss. Required when the line uses Hindi/Hinglish." },
    theme: { type: "string", description: "The idea in one short phrase." },
    big_idea: { type: "string", description: "Two sentences on why this lands for THIS institution." },
    audience: { type: "string", description: "The STUDENTS this speaks to at this institution, not the staff." },
    pain_framing: { type: "string", description: "What a STUDENT runs into, as a category observation, never an accusation." },
    talking_points: {
      type: "array",
      items: { type: "string" },
      description: "3-5 points an email may draw on, in terms of what a student gets. Only capabilities the product block lists.",
    },
    subject_angles: { type: "array", items: { type: "string" }, description: "3 short subject-line angles." },
    cta: { type: "string", description: "One ask, taken from the product's offers. The officer is a route to students, not a buyer." },
    language_notes: { type: "string", description: "How the line should be read; any Hinglish usage explained." },
  },
  required: [
    "campaign_line", "line_meaning", "theme", "big_idea", "audience",
    "pain_framing", "talking_points", "subject_angles", "cta", "language_notes",
  ],
  additionalProperties: false,
};

const SYSTEM = `You are a campaign planner for an Indian CONSUMER (B2C) product. You write
ONE campaign per institution, in the Indian market.

WHO THE CUSTOMER IS
The product is used by STUDENTS. They are the customer. The institution is not
buying anything and is not the user — the placement officer you are writing to is
a route to their students, an advocate, not a purchaser. So:
  - the campaign speaks to what a STUDENT gets: their CV, their applications,
    their first job. Not institutional efficiency, not placement-cell workload,
    not reporting, not "outcomes for your institution".
  - never write like enterprise software. No procurement, no licences, no
    rollout, no pilots, no "solution for your institution", no ROI.
  - the ask to the officer is that their students hear about it, not that the
    institution buys it.

THE MODEL TO FOLLOW
"Thanda Matlab Coca-Cola" is the reference. Study why it works:
  - three words, instantly repeatable
  - it names the brand, so no competitor can borrow it
  - it claims a CATEGORY ("thanda" = cold drinks), not a statistic
  - it is Hinglish and spoken, not translated corporate English
Produce a line with those properties for this product and this institution.

RULES
1. Output valid JSON only. No preamble, no markdown fences.
2. campaign_line: at most ${MAX_LINE_WORDS} words and it MUST contain the product name.
   Hinglish is welcome. Give the English gloss in line_meaning.
3. Claim a category, never a number. You have NO statistics, NO customer names and
   NO testimonials. Do not invent any. Do not write "proven", "#1", "award-winning",
   "trusted by hundreds" or any figure that is not in the input.
4. talking_points may only use capabilities present in the product block. You may
   not add features, integrations or outcomes the product does not list.
5. This is India. Speak the way students there speak about placements, campus
   season, sitting for companies and landing a first job. Hinglish is native
   here, not decoration. Do not use American campus-recruiting vocabulary.
6. pain_framing is about what a STUDENT runs into, framed as a category
   observation. Never an accusation about this institution and never a claim that
   their placement outcomes are poor.
7. No em-dashes. No exclamation marks. No "revolutionise", "cutting-edge",
   "leverage", "game-changer", "in today's competitive landscape".
8. Use the institution's own research facts to make big_idea specific to them.
   If a fact is not in the input, you do not know it.
9. If "avoid_lines" is present, those lines are already in use at OTHER
   institutions. Yours must be genuinely different, not the same construction with
   one word swapped. "Placement Ka Saathi", "Placement Ka Partner" and "Placement
   Ka Guru" are the same line three times. Change the IDEA, not the noun: work
   from this institution's own facts, its discipline, its region or its students'
   destination, so the line could not be lifted onto a different college.`;

export function buildCampaignPrompt({ product, research, orgName, recentLines = [] }) {
  const syn = research?.synthesis || {};
  const input = {
    organisation: {
      name: orgName || research?.university?.name || "",
      type: research?.university?.type || "",
      location: research?.university?.location || "",
      department: research?.university?.relevant_department || "",
      hooks: (syn.top_hooks || []).slice(0, 3),
      shared_context: syn.shared_context || "",
      // Only facts that cleared the citation floor reach a campaign, same as an email.
      facts: (research?.provenance || []).filter((p) => Number(p.confidence) >= 0.7).map((p) => p.fact).slice(0, 8),
    },
    product: product || null,
    // Stated rather than left implicit: an absent key invites the model to
    // improvise proof, a present empty one tells it there is none.
    proof_available: (product?.proof_points || []).length > 0
      ? product.proof_points
      : "NONE. The product site publishes no statistics, customers or testimonials. Claim a category, not a result.",
  };
  // Lines already running at other institutions. A campaign that is per-org in
  // the database but identical in the inbox is not a per-org campaign.
  if (recentLines.length) input.avoid_lines = recentLines.slice(0, 15);
  return { input, user: `INPUT\n${JSON.stringify(input, null, 2)}` };
}

// ── validation ──────────────────────────────────────────────────────────────

const norm = (s) => String(s ?? "").toLowerCase();
const numbersIn = (s) => (String(s ?? "").match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, ""));

const BANNED = [
  "revolutionise", "revolutionize", "cutting-edge", "leverage", "game-changer",
  "game changer", "in today's competitive landscape", "world-class", "best-in-class",
];
// Claims that assert evidence we do not have.
const UNBACKED = [
  /\bproven\b/i,
  // No leading \b: "#" is not a word character, so \b# never matches after a
  // space and "#1" walked straight through the gate.
  /#\s?1\b/i,
  /\bnumber one\b/i, /\baward[- ]winning\b/i, /\btrusted by\b/i,
  /\bindustry[- ]leading\b/i, /\bguaranteed\b/i, /\bmost popular\b/i,
  /\bmarket[- ]lead(er|ing)\b/i, /\bbest\b/i,
];

// Enterprise/procurement language. The product is B2C — students are the
// customer and the institution buys nothing — so this vocabulary is not a style
// preference, it is factually the wrong pitch. "Partner" is deliberately absent:
// radiusai.online's own CTA is "Partner With Us".
const B2B_LANGUAGE = [
  /\blicen[cs]e[sd]?\b/i, /\bprocurement\b/i, /\broll[- ]?out\b/i,
  /\bdeploy(ment|ing|ed)?\b/i, /\bpilot\b/i, /\bROI\b/, /\breturn on investment\b/i,
  /\benterprise\b/i, /\bvendor\b/i, /\bSLA\b/, /\bprocure\b/i,
  /\bsolution for your (institution|university|college)\b/i,
  /\binstitutional efficiency\b/i, /\bcost[- ]effective for your\b/i,
];

// Words every line here shares by construction — the brand plus the category it
// is claiming. What is left is the actual idea, and that is what must differ
// between two institutions.
// NB: Hindi idea-words ("saathi" = companion, "guru", "partner") are deliberately
// NOT here. Those carry the idea and are exactly what has to differ — stripping
// them would hide the duplication this gate exists to catch. Only the brand, the
// category itself, and structural particles are removed.
const CATEGORY_WORDS = new Set([
  "placement", "placements", "campus", "student", "students", "career", "careers",
  "hiring", "recruit", "recruitment", "job", "jobs", "matlab",
]);

export function distinctiveTokens(line, brand) {
  const brandLoose = String(brand || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return new Set(
    String(line || "").toLowerCase().split(/[^a-z0-9]+/)
      .filter(Boolean)
      .filter((w) => w.replace(/[^a-z0-9]/g, "") !== brandLoose)
      .filter((w) => !CATEGORY_WORDS.has(w))
      // Hindi particles ("ka", "ki", "ke", "se") are grammar, not the idea.
      .filter((w) => w.length > 2)
  );
}

/**
 * @returns {{valid: boolean, gates: object, failed: string[]}}
 */
export function validateCampaign({ campaign, product, input }) {
  const gates = {};
  const add = (name, pass, detail) => { gates[name] = { pass: Boolean(pass), detail: detail || null }; };

  const line = String(campaign?.campaign_line || "").trim();
  const lineWords = line.split(/\s+/).filter(Boolean);
  const allText = [
    line, campaign?.theme, campaign?.big_idea, campaign?.pain_framing,
    ...(campaign?.talking_points || []), ...(campaign?.subject_angles || []), campaign?.cta,
  ].filter(Boolean).join(" ");

  // 1. line_length — "Thanda Matlab Coca-Cola" is three words. A sentence is not a line.
  add("line_length", lineWords.length > 0 && lineWords.length <= MAX_LINE_WORDS,
    `${lineWords.length} words (max ${MAX_LINE_WORDS})`);

  // 2. line_names_brand — the property that makes a line ownable. Without the
  //    brand, a competitor can run the same campaign tomorrow.
  const brand = String(product?.name || "RadiusAI");
  const brandLoose = norm(brand).replace(/[^a-z0-9]/g, "");
  const lineLoose = norm(line).replace(/[^a-z0-9]/g, "");
  add("line_names_brand", brandLoose.length > 0 && lineLoose.includes(brandLoose),
    lineLoose.includes(brandLoose) ? null : `"${line}" does not name ${brand}`);

  // 3. no_unbacked_claims — we have no proof_points, so any evidence-shaped claim
  //    is fabricated by construction.
  const hasProof = (product?.proof_points || []).length > 0;
  const unbacked = hasProof ? [] : UNBACKED.filter((re) => re.test(allText)).map((re) => String(re));
  add("no_unbacked_claims", unbacked.length === 0,
    unbacked.length ? `claims evidence we do not have: ${unbacked.join(", ")}` : null);

  // 4. no_orphan_numbers — every figure must trace to the input.
  const allowed = new Set();
  const harvest = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) return v.forEach(harvest);
    if (typeof v === "object") return Object.values(v).forEach(harvest);
    numbersIn(v).forEach((n) => allowed.add(n));
  };
  harvest(input);
  const orphans = [...new Set(numbersIn(allText))].filter((n) => !allowed.has(n));
  add("no_orphan_numbers", orphans.length === 0,
    orphans.length ? `untraceable number(s): ${orphans.join(", ")}` : null);

  // 5. banned_phrases
  const hits = BANNED.filter((b) => norm(allText).includes(b));
  if (allText.includes("—") || allText.includes("–")) hits.push("em-dash");
  if (allText.includes("!")) hits.push("exclamation mark");
  add("banned_phrases", hits.length === 0, hits.length ? hits.join(", ") : null);

  // 6. talking_points_grounded — a point naming a capability the product does not
  //    have is a promise we cannot keep.
  const capWords = new Set(
    (product?.capabilities || [])
      .flatMap((c) => `${c.name} ${c.description}`.toLowerCase().split(/[^a-z0-9]+/))
      .filter((w) => w.length > 3)
  );
  const known = /cv|resume|ats|cover letter|email|dashboard|track|applicat|placement|student|univers|demo/i;
  const ungrounded = (campaign?.talking_points || []).filter((t) => {
    if (known.test(t)) return false;
    const words = norm(t).split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    return !words.some((w) => capWords.has(w));
  });
  add("talking_points_grounded", ungrounded.length === 0,
    ungrounded.length ? `not grounded in the product: ${ungrounded.join(" | ").slice(0, 160)}` : null);

  // 7. b2c_framing — enterprise vocabulary means the campaign is pitching the
  //    wrong customer entirely, not merely using the wrong tone.
  const b2bHits = B2B_LANGUAGE.filter((re) => re.test(allText)).map((re) => String(re).slice(1, -2));
  add("b2c_framing", b2bHits.length === 0,
    b2bHits.length ? `enterprise language in a B2C campaign: ${b2bHits.join(", ")}` : null);

  // 8. line_is_distinct — the line must not already be running elsewhere. Compared
  //    on DISTINCTIVE tokens (brand and category words removed), because every
  //    line here legitimately contains "placement" and "RadiusAI"; what has to
  //    differ is the idea carried by the remaining words.
  const avoid = input?.avoid_lines || [];
  const clash = avoid.filter((prev) => {
    if (norm(prev).replace(/[^a-z0-9]/g, "") === norm(line).replace(/[^a-z0-9]/g, "")) return true;
    const a = distinctiveTokens(prev, product?.name);
    const b = distinctiveTokens(line, product?.name);
    if (!a.size || !b.size) return false;
    const shared = [...a].filter((w) => b.has(w)).length;
    return shared === a.size && shared === b.size; // same idea, reworded punctuation
  });
  add("line_is_distinct", clash.length === 0,
    clash.length ? `already in use elsewhere: "${clash[0]}"` : null);

  // 9. has_meaning — a Hinglish line without a gloss cannot be reviewed by
  //    someone who does not read it.
  const nonAscii = /[^\x00-\x7F]/.test(line);
  const hinglish = /\b(matlab|hai|ka|ki|ke|se|aur|nahi|sirf|jab|toh|bas|apna|apni)\b/i.test(line);
  add("has_meaning", !(nonAscii || hinglish) || Boolean(String(campaign?.line_meaning || "").trim()),
    "a Hinglish line needs line_meaning");

  const failed = Object.entries(gates).filter(([, g]) => !g.pass).map(([n]) => n);
  return { valid: failed.length === 0, gates, failed };
}

// ── generation ──────────────────────────────────────────────────────────────

/**
 * Generate one campaign for one organisation.
 * @returns {Promise<{campaign?, validation?, prompts, input, error?}>}
 */
export async function generateCampaign({ product, research, orgName, recentLines = [], attempts = 2 }) {
  const { input, user } = buildCampaignPrompt({ product, research, orgName, recentLines });
  let userPrompt = user;
  let last = null;

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    const prompts = { system: SYSTEM, user: userPrompt, version: CAMPAIGN_PROMPT_VERSION };
    const r = await chatJSON({
      system: SYSTEM,
      user: userPrompt,
      schema: CAMPAIGN_SCHEMA,
      schemaName: "campaign",
      maxTokens: 1500,
      kind: "gen",
    });
    if (r.error) return { prompts, input, error: r.error, attempts: attempt };

    const c = r.value || {};
    if (!c.campaign_line) return { prompts, input, error: "The model returned no campaign line.", attempts: attempt };

    const campaign = {
      campaign_line: String(c.campaign_line).trim(),
      line_meaning: c.line_meaning || null,
      theme: c.theme || null,
      big_idea: c.big_idea || null,
      audience: c.audience || null,
      pain_framing: c.pain_framing || null,
      talking_points: (c.talking_points || []).filter(Boolean).slice(0, 5),
      subject_angles: (c.subject_angles || []).filter(Boolean).slice(0, 3),
      cta: c.cta || null,
      language_notes: c.language_notes || null,
    };
    const validation = validateCampaign({ campaign, product, input });
    last = { prompts, input, campaign, validation, attempts: attempt };
    if (validation.valid) return last;

    const notes = validation.failed.map((g) => `- ${g}: ${validation.gates[g].detail || "failed"}`).join("\n");
    userPrompt = `${user}

A previous attempt was REJECTED by the automated validator:
${notes}

Rewrite so every one of those is fixed. Reminders: the line is at most
${MAX_LINE_WORDS} words and must contain the product name; claim a category, not a
statistic; no numbers that are not in the input.`;
  }
  return last;
}

// ── persistence (one current campaign per organisation) ─────────────────────

export async function currentCampaignForOrg(orgKey) {
  const { rows } = await pool.query(
    `SELECT * FROM radius_campaigns WHERE lower(org_key) = lower($1) AND is_current LIMIT 1`,
    [orgKey]
  );
  return rows[0] || null;
}

export async function saveCampaign({ orgKey, orgName, orgResearchId, productId, result }) {
  const c = result?.campaign || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: prev } = await client.query(
      `SELECT COALESCE(max(version), 0) AS v FROM radius_campaigns WHERE lower(org_key) = lower($1)`,
      [orgKey]
    );
    await client.query(
      `UPDATE radius_campaigns SET is_current = false WHERE lower(org_key) = lower($1) AND is_current`,
      [orgKey]
    );
    const { rows } = await client.query(
      `INSERT INTO radius_campaigns (
         org_key, version, is_current, org_research_id, radius_product_id, org_name,
         campaign_line, line_meaning, theme, big_idea, audience, pain_framing,
         talking_points, subject_angles, cta, language_notes,
         input, prompt_system, prompt_user, prompt_version, output,
         is_valid, validation, provider, model, error)
       VALUES ($1,$2,true,$3,$4,$5, $6,$7,$8,$9,$10,$11, $12,$13,$14,$15,
               $16,$17,$18,$19,$20, $21,$22,$23,$24,$25)
       RETURNING *`,
      [
        orgKey, Number(prev[0].v) + 1, orgResearchId || null, productId || null, orgName || null,
        c.campaign_line || null, c.line_meaning, c.theme, c.big_idea, c.audience, c.pain_framing,
        c.talking_points || [], c.subject_angles || [], c.cta, c.language_notes,
        JSON.stringify(result?.input || {}), result?.prompts?.system || "", result?.prompts?.user || "",
        result?.prompts?.version || null, JSON.stringify(c),
        Boolean(result?.validation?.valid), JSON.stringify(result?.validation?.gates || {}),
        aiProvider(), process.env.OPENAI_GEN_MODEL || process.env.ANTHROPIC_GEN_MODEL || null,
        result?.error || null,
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

/** Stored row -> the block the email prompt consumes. */
export function campaignBlock(row) {
  if (!row) return null;
  return {
    campaign_line: row.campaign_line,
    line_meaning: row.line_meaning,
    theme: row.theme,
    big_idea: row.big_idea,
    pain_framing: row.pain_framing,
    talking_points: row.talking_points || [],
    subject_angles: row.subject_angles || [],
    cta: row.cta,
  };
}
