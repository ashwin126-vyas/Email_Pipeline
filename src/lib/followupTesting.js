// followup_testing — generate and store the follow-up sequence for one
// email_testing row.
//
// Steps are generated IN ORDER and each one is shown the real text of every step
// before it, because the gates in generateFollowup.js are comparative. Generating
// step 2 without step 1 in hand would produce two emails that repeat each other,
// which is the exact failure the sequence is supposed to avoid.
//
// Nothing here sends email.

import { pool } from "./db.js";
import { generateFollowup, FOLLOWUP_STEPS } from "./generateFollowup.js";
import { currentRadiusProduct, productBlock } from "./radiusProduct.js";
import { currentCampaignForOrg, campaignBlock } from "./generateCampaign.js";
import { aiProvider, aiModel } from "./llm.js";

export function followupHint(e) {
  return /relation .*followup_testing.* does not exist/i.test(e.message)
    ? "followup_testing is missing. Run `npm run db:setup` to apply schema.sql."
    : e.message;
}

/** The original email row plus everything needed to write a reply to its silence. */
async function loadThread(emailTestingId) {
  const { rows } = await pool.query(`SELECT * FROM email_testing WHERE id = $1`, [emailTestingId]);
  const original = rows[0];
  if (!original) return { error: `email_testing #${emailTestingId} not found.` };

  const { rows: prev } = await pool.query(
    `SELECT * FROM followup_testing WHERE email_testing_id = $1 ORDER BY step_number`,
    [emailTestingId]
  );
  return { original, previous: prev };
}

async function saveFollowup({ original, step, result }) {
  const cfg = FOLLOWUP_STEPS[step] || {};
  const { rows } = await pool.query(
    `INSERT INTO followup_testing (
       email_testing_id, step_number, send_after_days,
       org_key, org_name, person_name, person_email, run_label,
       goal, angle, input, prompt_system, prompt_user, prompt_version,
       contract, output, subject, body, warnings, is_valid, validation,
       status, provider, model, error)
     VALUES ($1,$2,$3, $4,$5,$6,$7,$8, $9,$10,$11,$12,$13,$14,
             $15,$16,$17,$18,$19,$20,$21, $22,$23,$24,$25)
     ON CONFLICT (email_testing_id, step_number) DO UPDATE SET
       send_after_days = EXCLUDED.send_after_days,
       goal = EXCLUDED.goal, angle = EXCLUDED.angle,
       input = EXCLUDED.input, prompt_system = EXCLUDED.prompt_system,
       prompt_user = EXCLUDED.prompt_user, prompt_version = EXCLUDED.prompt_version,
       contract = EXCLUDED.contract, output = EXCLUDED.output,
       subject = EXCLUDED.subject, body = EXCLUDED.body,
       warnings = EXCLUDED.warnings, is_valid = EXCLUDED.is_valid,
       validation = EXCLUDED.validation, status = EXCLUDED.status,
       provider = EXCLUDED.provider, model = EXCLUDED.model,
       error = EXCLUDED.error, created_at = now()
     RETURNING *`,
    [
      original.id, step, cfg.send_after_days || null,
      original.org_key, original.org_name, original.person_name, original.person_email, original.run_label,
      cfg.goal || null, result?.angle || null,
      JSON.stringify({ step, email_testing_id: original.id, send_after_days: cfg.send_after_days }),
      result?.prompts?.system || null, result?.prompts?.user || null, result?.prompts?.version || null,
      JSON.stringify(result?.contract || {}),
      JSON.stringify({
        subject: result?.subject || null, body: result?.body || null,
        new_specific: result?.newSpecific || null, angle: result?.angle || null,
        ask: result?.ask || null, error: result?.error || null,
      }),
      result?.subject || null, result?.body || null,
      result?.warnings || [],
      Boolean(result?.validation?.valid),
      JSON.stringify(result?.validation?.gates || {}),
      result?.error ? "failed" : result?.validation?.valid ? "draft" : "rejected",
      aiProvider(), aiModel("gen"),
      result?.error || null,
    ]
  );
  return rows[0];
}

/**
 * Generate the whole follow-up sequence for one email_testing row.
 *
 * @param {{ emailTestingId: number, steps?: number[], regenerate?: boolean }} a
 * @returns {Promise<{email_testing_id, person, org, followups: object[], error?}>}
 */
export async function runFollowupTest({ emailTestingId, steps = [1, 2], regenerate = false } = {}) {
  const loaded = await loadThread(emailTestingId);
  if (loaded.error) return { error: loaded.error };
  const { original } = loaded;

  const productRow = await currentRadiusProduct();
  const product = productBlock(productRow);
  const campaignRow = original.org_key ? await currentCampaignForOrg(original.org_key) : null;
  const campaign = campaignBlock(campaignRow);
  // The research output stored on the original row — no re-crawl. The facts that
  // were true when we wrote the first email are the facts we may still cite.
  const research = original.research_output || {};

  // Previous steps accumulate as we go, so step 2 is written against the real
  // step 1 rather than a guess at it.
  let previous = regenerate ? [] : loaded.previous.filter((p) => !steps.includes(p.step_number));
  const out = [];

  for (const step of steps) {
    const existing = !regenerate && loaded.previous.find((p) => p.step_number === step);
    if (existing) {
      previous = [...previous, existing];
      out.push({ ...existing, cached: true });
      continue;
    }

    const result = await generateFollowup({
      step,
      original,
      previous: previous.map((p) => ({ step_number: p.step_number, subject: p.subject, body: p.body })),
      product, campaign, research,
    });
    if (!result) {
      out.push({ step_number: step, error: "generation returned nothing" });
      continue;
    }
    const row = await saveFollowup({ original, step, result });
    previous = [...previous, row];
    out.push({ ...row, cached: false });
  }

  return {
    email_testing_id: original.id,
    person: original.person_name,
    org: original.org_name,
    original: { subject: original.subject, body: original.body },
    followups: out.map((f) => ({
      id: f.id,
      step: f.step_number,
      send_after_days: f.send_after_days,
      subject: f.subject,
      body: f.body,
      angle: f.angle,
      valid: f.is_valid,
      status: f.status,
      warnings: f.warnings || [],
      validation: f.validation || {},
      cached: Boolean(f.cached),
      error: f.error || null,
    })),
  };
}
