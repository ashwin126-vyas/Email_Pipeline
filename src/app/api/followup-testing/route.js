import { runFollowupTest, followupHint } from "@/lib/followupTesting";
import { aiEnabled } from "@/lib/llm";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/followup-testing
// Body: { email_testing_id, steps?: [1,2], regenerate?: boolean }
//
// Generates the follow-up sequence for one email_testing row. Steps run in order
// and each is written against the real text of every earlier step. Nothing sends.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const id = Number(body.email_testing_id);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "email_testing_id is required." }, { status: 400 });
  }
  const steps = Array.isArray(body.steps) && body.steps.length
    ? body.steps.map(Number).filter((n) => n >= 1 && n <= 5).sort((a, b) => a - b)
    : [1, 2];
  if (!aiEnabled()) {
    return Response.json(
      { error: "No AI key set. Add OPENAI_API_KEY (or ANTHROPIC_API_KEY) to .env." },
      { status: 422 }
    );
  }

  try {
    const r = await runFollowupTest({ emailTestingId: id, steps, regenerate: Boolean(body.regenerate) });
    if (r.error) return Response.json({ error: r.error }, { status: 404 });
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: followupHint(e) }, { status: 500 });
  }
}

// GET /api/followup-testing?email_testing_id=25  |  ?limit=50
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("email_testing_id"));
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 50, 1), 200);

  try {
    const { rows } = await pool.query(
      `SELECT id, email_testing_id, step_number, send_after_days, person_name, org_name,
              run_label, angle, subject, body, warnings, is_valid, status, created_at
         FROM followup_testing
        ${Number.isInteger(id) && id > 0 ? "WHERE email_testing_id = $2" : ""}
        ORDER BY email_testing_id, step_number
        LIMIT $1`,
      Number.isInteger(id) && id > 0 ? [limit, id] : [limit]
    );
    return Response.json({ followups: rows });
  } catch (e) {
    return Response.json({ error: followupHint(e) }, { status: 500 });
  }
}
