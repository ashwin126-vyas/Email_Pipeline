import { pool } from "@/lib/db";
import { automationHint } from "@/lib/automationHint";
import { VALID_STATUS } from "../route";

export const dynamic = "force-dynamic";

// PUT /api/campaigns/:id — patch any subset of fields. Setting status to
// 'active' is how you START a campaign; 'paused' pauses it. The worker only
// touches campaigns whose status is 'active'.
export async function PUT(req, { params }) {
  const { id } = await params;
  const campaignId = parseInt(id, 10);
  if (!campaignId) {
    return Response.json({ error: "Invalid campaign id." }, { status: 400 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const sets = [];
  const values = [];
  let i = 1;
  const set = (col, val) => {
    sets.push(`${col} = $${i}`);
    values.push(val);
    i += 1;
  };

  if (typeof body.name === "string" && body.name.trim()) set("name", body.name.trim());
  if (Number.isInteger(body.sequence_id)) set("sequence_id", body.sequence_id);
  if (body.target_filter && typeof body.target_filter === "object") {
    set("target_filter", body.target_filter);
  }
  if (Number.isFinite(body.daily_cap)) set("daily_cap", clampInt(body.daily_cap, 1, 100000));
  if (Number.isFinite(body.window_start)) set("window_start", clampInt(body.window_start, 0, 23));
  if (Number.isFinite(body.window_end)) set("window_end", clampInt(body.window_end, 1, 24));
  if (typeof body.timezone === "string" && body.timezone.trim()) set("timezone", body.timezone.trim());
  if (typeof body.status === "string") {
    if (!VALID_STATUS.has(body.status)) {
      return Response.json({ error: `status must be one of ${[...VALID_STATUS].join(", ")}.` }, { status: 400 });
    }
    set("status", body.status);
  }

  if (sets.length === 0) {
    return Response.json({ error: "Nothing to update." }, { status: 400 });
  }

  values.push(campaignId);
  try {
    const { rows } = await pool.query(
      `UPDATE campaigns SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $${i}
        RETURNING id, name, target_filter, sequence_id, daily_cap,
                  window_start, window_end, timezone, status, created_at, updated_at`,
      values
    );
    if (rows.length === 0) {
      return Response.json({ error: "Campaign not found." }, { status: 404 });
    }
    return Response.json({ campaign: rows[0] });
  } catch (e) {
    if (/foreign key/i.test(e.message)) {
      return Response.json({ error: "That sequence_id does not exist." }, { status: 400 });
    }
    return Response.json({ error: automationHint(e) }, { status: 500 });
  }
}

// DELETE /api/campaigns/:id — cascades to its enrollments (see schema FK).
export async function DELETE(_req, { params }) {
  const { id } = await params;
  const campaignId = parseInt(id, 10);
  if (!campaignId) {
    return Response.json({ error: "Invalid campaign id." }, { status: 400 });
  }
  try {
    const { rowCount } = await pool.query(`DELETE FROM campaigns WHERE id = $1`, [campaignId]);
    if (rowCount === 0) {
      return Response.json({ error: "Campaign not found." }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: automationHint(e) }, { status: 500 });
  }
}

function clampInt(v, min, max) {
  return Math.min(Math.max(Math.trunc(v), min), max);
}
