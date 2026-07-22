import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/sends — the email send log, newest first.
// Each row is LEFT JOINed back to the live `contacts` table (owned by the other
// app) so we can show the contact's current title/industry alongside the values
// snapshotted at send time. `?limit=` caps the result (default 200).
export async function GET(req) {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1000);

  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.email, s.name, s.company, s.subject, s.body,
              s.status, s.message_id, s.error, s.template_id, s.sent_at,
              s.step_number, s.campaign_id,
              s.opened_at, s.clicked_at, s.bounced_at, s.complained_at,
              t.name AS template_name,
              cam.name AS campaign_name
       FROM email_logs s
       LEFT JOIN email_templates t ON t.id = s.template_id
       LEFT JOIN campaigns cam     ON cam.id = s.campaign_id
       ORDER BY s.sent_at DESC
       LIMIT $1`,
      [limit]
    );

    const sent = rows.filter((r) => r.status === "sent").length;
    return Response.json({
      sends: rows,
      total: rows.length,
      sent,
      failed: rows.length - sent,
    });
  } catch (e) {
    const message = /relation .*email_logs.* does not exist/i.test(e.message)
      ? "The `email_logs` table does not exist yet. Run `npm run db:setup`."
      : e.message;
    return Response.json({ error: message }, { status: 500 });
  }
}
