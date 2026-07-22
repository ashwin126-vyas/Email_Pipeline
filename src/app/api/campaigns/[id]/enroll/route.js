import { pool } from "@/lib/db";
import { automationHint } from "@/lib/automationHint";
import { buildContactWhere } from "@/lib/contactFilter";

export const dynamic = "force-dynamic";

// POST /api/campaigns/:id/enroll
// Body: { preview?: boolean }
//
// Pulls every `contacts` row matching the campaign's target_filter (with a
// usable email) and inserts one enrollment each at current_step = 1,
// next_action_at = now() — so the heartbeat picks them up on its next pass.
// UNIQUE (campaign_id, apollo_id) + ON CONFLICT DO NOTHING means re-enrolling is
// safe and never duplicates. `preview: true` only counts, inserting nothing.
export async function POST(req, { params }) {
  const { id } = await params;
  const campaignId = parseInt(id, 10);
  if (!campaignId) {
    return Response.json({ error: "Invalid campaign id." }, { status: 400 });
  }

  let body = {};
  try {
    body = await req.json();
  } catch {
    /* body optional */
  }
  const preview = body?.preview === true;

  try {
    const { rows: campRows } = await pool.query(
      `SELECT id, target_filter FROM campaigns WHERE id = $1`,
      [campaignId]
    );
    if (campRows.length === 0) {
      return Response.json({ error: "Campaign not found." }, { status: 404 });
    }
    const targetFilter = campRows[0].target_filter || {};

    // $1 is the campaign id; contact filter params start at $2.
    const { where, values } = buildContactWhere(targetFilter, 2);
    const params2 = [campaignId, ...values];

    if (preview) {
      const { rows } = await pool.query(
        `SELECT
           count(*)::int AS matched,
           count(*) FILTER (
             WHERE apollo_id IN (SELECT apollo_id FROM enrollments WHERE campaign_id = $1)
           )::int AS already_enrolled
         FROM contacts
         WHERE ${where}`,
        params2
      );
      return Response.json({
        matched: rows[0].matched,
        already_enrolled: rows[0].already_enrolled,
        would_enroll: rows[0].matched - rows[0].already_enrolled,
      });
    }

    const { rowCount } = await pool.query(
      `INSERT INTO enrollments (campaign_id, apollo_id)
       SELECT $1, apollo_id FROM contacts WHERE ${where}
       ON CONFLICT (campaign_id, apollo_id) DO NOTHING`,
      params2
    );
    return Response.json({ enrolled: rowCount });
  } catch (e) {
    return Response.json({ error: automationHint(e) }, { status: 500 });
  }
}
