import { pool } from "@/lib/db";
import { emailTestingHint } from "@/lib/emailTesting";

export const dynamic = "force-dynamic";

// POST /api/email-testing/lookup   { emails: string[] }
//
// "Which of these contacts already has a generated email?" — the newest run per
// address, so the Recipients table can show Preview instead of Generate for a
// row that was generated last week, on another page, or from the Generation tab.
//
// Newest wins even when it is the rejected one: hiding a fresh rejection behind
// an older valid draft would show the wrong email in Preview.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const emails = (Array.isArray(body.emails) ? body.emails : [])
    .filter((e) => typeof e === "string" && e.trim())
    .map((e) => e.trim().toLowerCase())
    .slice(0, 500);

  if (emails.length === 0) return Response.json({ generated: {} });

  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (lower(t.person_email))
              lower(t.person_email) AS key,
              t.id, t.subject, t.body, t.is_valid, t.status, t.org_name, t.warnings,
              t.created_at,
              t.campaign_output->>'campaign_line' AS campaign_line,
              (SELECT count(*)::int FROM followup_testing f WHERE f.email_testing_id = t.id)
                AS followup_count
         FROM email_testing t
        WHERE t.person_email IS NOT NULL
          AND t.subject IS NOT NULL
          AND lower(t.person_email) = ANY($1)
        ORDER BY lower(t.person_email), t.created_at DESC`,
      [emails]
    );

    const generated = {};
    for (const r of rows) generated[r.key] = r;
    return Response.json({ generated });
  } catch (e) {
    return Response.json({ error: emailTestingHint(e) }, { status: 500 });
  }
}
