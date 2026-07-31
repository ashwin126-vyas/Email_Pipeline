import { runEmailTest, emailTestingHint } from "@/lib/emailTesting";
import { aiEnabled } from "@/lib/llm";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/email-testing
// Body: { person, mode?, target?, email_intent?, sender_context?, constraints?,
//         refresh?, refresh_campaign?, run_label? }
//
// Runs the full chain — research (them) + radius (us) -> campaign (per
// organisation, cached and shared) -> email (per person) — and logs every input
// and output to `email_testing`.
//
// Returns { id, research, radius, campaign, email }. Nothing is sent.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const person = body.person || {};
  if (!String(person.full_name || "").trim()) {
    return Response.json({ error: "person.full_name is required." }, { status: 400 });
  }
  const mode = body.mode === "on_behalf" ? "on_behalf" : "to_person";
  if (mode === "on_behalf" && !body.target) {
    return Response.json({ error: "target is required when mode is on_behalf." }, { status: 400 });
  }
  if (!aiEnabled()) {
    return Response.json(
      { error: "No AI key set. Add OPENAI_API_KEY (or ANTHROPIC_API_KEY) to .env." },
      { status: 422 }
    );
  }

  try {
    const r = await runEmailTest({
      person,
      mode,
      target: body.target,
      email_intent: body.email_intent,
      sender_context: body.sender_context,
      constraints: body.constraints || {},
      refresh: Boolean(body.refresh),
      refresh_campaign: Boolean(body.refresh_campaign),
      run_label: body.run_label || null,
    });
    if (r.error) return Response.json({ error: r.error }, { status: 422 });
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: emailTestingHint(e) }, { status: 500 });
  }
}

// GET /api/email-testing?limit=20[&org_key=]
// The test log, newest first. Bodies included so a run can be read back without
// a second call; the heavy prompt/contract columns are left out on purpose.
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 20, 1), 200);
  const orgKey = searchParams.get("org_key");

  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.run_label, t.org_key, t.org_name, t.person_name, t.person_email, t.mode,
              t.email_intent, t.subject, t.body, t.coverage, t.tone, t.warnings, t.is_valid,
              t.status, t.campaign_cached, t.radius_campaign_id, t.step_number, t.created_at,
              t.campaign_output->>'campaign_line' AS campaign_line,
              (SELECT count(*)::int FROM followup_testing f WHERE f.email_testing_id = t.id)
                AS followup_count
         FROM email_testing t
        ${orgKey ? "WHERE lower(t.org_key) = lower($2)" : ""}
        ORDER BY t.created_at DESC
        LIMIT $1`,
      orgKey ? [limit, orgKey] : [limit]
    );
    return Response.json({ runs: rows });
  } catch (e) {
    return Response.json({ error: emailTestingHint(e) }, { status: 500 });
  }
}
