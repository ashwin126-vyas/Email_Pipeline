import { pool } from "@/lib/db";
import { automationHint } from "@/lib/automationHint";

export const dynamic = "force-dynamic";

// GET /api/sequences — every sequence with its ordered steps (+ template names).
export async function GET() {
  try {
    const { rows: sequences } = await pool.query(
      `SELECT id, name, created_at FROM sequences ORDER BY created_at DESC`
    );
    const { rows: steps } = await pool.query(
      `SELECT st.id, st.sequence_id, st.step_number, st.delay_hours,
              st.template_id, t.name AS template_name
         FROM sequence_steps st
         LEFT JOIN email_templates t ON t.id = st.template_id
        ORDER BY st.sequence_id, st.step_number`
    );
    const bySeq = new Map();
    for (const s of steps) {
      if (!bySeq.has(s.sequence_id)) bySeq.set(s.sequence_id, []);
      bySeq.get(s.sequence_id).push(s);
    }
    return Response.json({
      sequences: sequences.map((s) => ({ ...s, steps: bySeq.get(s.id) || [] })),
    });
  } catch (e) {
    return Response.json({ error: automationHint(e) }, { status: 500 });
  }
}

// POST /api/sequences
// Body: { name, steps: [{ delay_hours, template_id }] }  (order = step order)
// step_number is assigned from array order (1-based) so the caller can't create
// gaps or duplicates.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = (body.name || "").trim();
  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (!name) {
    return Response.json({ error: "A sequence name is required." }, { status: 400 });
  }
  if (steps.length === 0) {
    return Response.json({ error: "A sequence needs at least one step." }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO sequences (name) VALUES ($1) RETURNING id, name, created_at`,
      [name]
    );
    const seq = rows[0];
    let n = 1;
    for (const step of steps) {
      const templateId = Number.isInteger(step.template_id) ? step.template_id : null;
      const delay = Number.isFinite(step.delay_hours) ? Math.max(0, Math.trunc(step.delay_hours)) : 0;
      await client.query(
        `INSERT INTO sequence_steps (sequence_id, step_number, delay_hours, template_id)
         VALUES ($1, $2, $3, $4)`,
        [seq.id, n, delay, templateId]
      );
      n += 1;
    }
    await client.query("COMMIT");
    return Response.json({ sequence: seq }, { status: 201 });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return Response.json({ error: automationHint(e) }, { status: 500 });
  } finally {
    client.release();
  }
}
