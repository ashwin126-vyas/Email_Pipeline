import { pool } from "@/lib/db";
import { emailTestingHint } from "@/lib/emailTesting";

export const dynamic = "force-dynamic";

// GET /api/email-testing/:id[?prompts=1]
//
// One run with every stage it recorded — research, product, campaign, email —
// plus the follow-up steps generated from it, so the UI can show the whole
// chain from a single fetch instead of stitching three calls together.
//
// The two prompt pairs are large and only interesting when arguing with a
// result, so they are opt-in (`?prompts=1`) rather than paid for on every open.
export async function GET(req, { params }) {
  const { id } = await params;
  const runId = parseInt(id, 10);
  if (!runId) {
    return Response.json({ error: "Invalid run id." }, { status: 400 });
  }
  const withPrompts = new URL(req.url).searchParams.get("prompts") === "1";

  try {
    const { rows } = await pool.query(
      `SELECT id, run_label, org_key, org_name, person_name, person_email, mode,
              email_intent, step_number, parent_id,
              person_research_id, org_research_id, radius_product_id, radius_campaign_id,
              research_input, research_output,
              radius_input, radius_output,
              campaign_input, campaign_output, campaign_cached,
              email_input, email_contract, email_output,
              subject, body, coverage, tone, warnings, is_valid, validation,
              status, provider, model, error, created_at
              ${withPrompts
                ? `, campaign_prompt_system, campaign_prompt_user,
                     email_prompt_system, email_prompt_user`
                : ""}
         FROM email_testing
        WHERE id = $1`,
      [runId]
    );
    const run = rows[0];
    if (!run) {
      return Response.json({ error: `Run #${runId} not found.` }, { status: 404 });
    }

    // The campaign is stored per organisation and shared, so the row's own
    // validation is the campaign's only when it generated one. On a cached run
    // the gates live on radius_campaigns — read them from there rather than
    // showing a campaign with no verdict.
    let campaignValidation = {};
    let campaignValid = null;
    if (run.radius_campaign_id) {
      const { rows: c } = await pool.query(
        `SELECT validation, is_valid FROM radius_campaigns WHERE id = $1`,
        [run.radius_campaign_id]
      );
      campaignValidation = c[0]?.validation || {};
      campaignValid = c[0]?.is_valid ?? null;
    }

    const { rows: followups } = await pool.query(
      `SELECT id, step_number, send_after_days, goal, angle, subject, body,
              warnings, is_valid, validation, status, error, created_at
         FROM followup_testing
        WHERE email_testing_id = $1
        ORDER BY step_number`,
      [runId]
    );

    return Response.json({
      run: { ...run, campaign_validation: campaignValidation, campaign_valid: campaignValid },
      followups,
    });
  } catch (e) {
    return Response.json({ error: emailTestingHint(e) }, { status: 500 });
  }
}

// DELETE /api/email-testing/:id — drop a test run. Its follow-up steps go with
// it (ON DELETE CASCADE). Nothing here was ever sent, so this only discards a
// draft.
export async function DELETE(_req, { params }) {
  const { id } = await params;
  const runId = parseInt(id, 10);
  if (!runId) {
    return Response.json({ error: "Invalid run id." }, { status: 400 });
  }

  try {
    const { rowCount } = await pool.query(`DELETE FROM email_testing WHERE id = $1`, [runId]);
    if (!rowCount) {
      return Response.json({ error: `Run #${runId} not found.` }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: emailTestingHint(e) }, { status: 500 });
  }
}
