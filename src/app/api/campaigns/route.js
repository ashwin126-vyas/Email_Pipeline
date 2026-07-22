import { pool } from "@/lib/db";
import { automationHint } from "@/lib/automationHint";

export const dynamic = "force-dynamic";

const VALID_STATUS = new Set(["draft", "active", "paused", "done"]);

// GET /api/campaigns — campaigns with their sequence name, per-status enrollment
// counts, and how many were already sent "today" in the campaign's own timezone
// (what the worker's daily cap is measured against).
export async function GET() {
  try {
    const { rows: campaigns } = await pool.query(
      `SELECT c.id, c.name, c.target_filter, c.sequence_id, c.daily_cap,
              c.window_start, c.window_end, c.timezone, c.status,
              c.created_at, c.updated_at,
              s.name AS sequence_name,
              (SELECT count(*) FROM email_logs es
                WHERE es.campaign_id = c.id AND es.status = 'sent'
                  AND es.sent_at >= date_trunc('day', now() AT TIME ZONE c.timezone)
                                    AT TIME ZONE c.timezone
              )::int AS sent_today
         FROM campaigns c
         JOIN sequences s ON s.id = c.sequence_id
        ORDER BY c.created_at DESC`
    );

    const { rows: counts } = await pool.query(
      `SELECT campaign_id, status, count(*)::int AS n
         FROM enrollments GROUP BY campaign_id, status`
    );
    const byCampaign = new Map();
    for (const r of counts) {
      if (!byCampaign.has(r.campaign_id)) byCampaign.set(r.campaign_id, {});
      byCampaign.get(r.campaign_id)[r.status] = r.n;
    }

    return Response.json({
      campaigns: campaigns.map((c) => {
        const st = byCampaign.get(c.id) || {};
        const total = Object.values(st).reduce((a, b) => a + b, 0);
        return { ...c, enrollment_counts: st, enrollment_total: total };
      }),
    });
  } catch (e) {
    return Response.json({ error: automationHint(e) }, { status: 500 });
  }
}

// POST /api/campaigns
// Body: { name, sequence_id, target_filter?, daily_cap?, window_start?,
//         window_end?, timezone? }  — created as status 'draft'.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = (body.name || "").trim();
  const sequenceId = Number.isInteger(body.sequence_id) ? body.sequence_id : null;
  if (!name || !sequenceId) {
    return Response.json(
      { error: "name and a sequence_id are required." },
      { status: 400 }
    );
  }

  const targetFilter =
    body.target_filter && typeof body.target_filter === "object"
      ? body.target_filter
      : {};
  const dailyCap = clampInt(body.daily_cap, 1, 100000, 30);
  const windowStart = clampInt(body.window_start, 0, 23, 9);
  const windowEnd = clampInt(body.window_end, 1, 24, 18);
  const timezone = (body.timezone || "Asia/Kolkata").trim();

  try {
    const { rows } = await pool.query(
      `INSERT INTO campaigns
         (name, sequence_id, target_filter, daily_cap, window_start, window_end, timezone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, target_filter, sequence_id, daily_cap,
                 window_start, window_end, timezone, status, created_at, updated_at`,
      [name, sequenceId, targetFilter, dailyCap, windowStart, windowEnd, timezone]
    );
    return Response.json({ campaign: rows[0] }, { status: 201 });
  } catch (e) {
    if (/foreign key/i.test(e.message)) {
      return Response.json({ error: "That sequence_id does not exist." }, { status: 400 });
    }
    return Response.json({ error: automationHint(e) }, { status: 500 });
  }
}

export { VALID_STATUS };

function clampInt(v, min, max, fallback) {
  const n = Number.isFinite(v) ? Math.trunc(v) : fallback;
  return Math.min(Math.max(n, min), max);
}
