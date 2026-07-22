import { pool } from "@/lib/db";
import { automationHint } from "@/lib/automationHint";

export const dynamic = "force-dynamic";

// PUT /api/sequences/:id — rename and replace the step list wholesale.
// Body: { name, steps: [{ delay_hours, template_id }] }
export async function PUT(req, { params }) {
  const { id } = await params;
  const sequenceId = parseInt(id, 10);
  if (!sequenceId) {
    return Response.json({ error: "Invalid sequence id." }, { status: 400 });
  }

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
    const { rowCount } = await client.query(
      `UPDATE sequences SET name = $1 WHERE id = $2`,
      [name, sequenceId]
    );
    if (rowCount === 0) {
      await client.query("ROLLBACK");
      return Response.json({ error: "Sequence not found." }, { status: 404 });
    }
    await client.query(`DELETE FROM sequence_steps WHERE sequence_id = $1`, [sequenceId]);
    let n = 1;
    for (const step of steps) {
      const templateId = Number.isInteger(step.template_id) ? step.template_id : null;
      const delay = Number.isFinite(step.delay_hours) ? Math.max(0, Math.trunc(step.delay_hours)) : 0;
      await client.query(
        `INSERT INTO sequence_steps (sequence_id, step_number, delay_hours, template_id)
         VALUES ($1, $2, $3, $4)`,
        [sequenceId, n, delay, templateId]
      );
      n += 1;
    }
    await client.query("COMMIT");
    return Response.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return Response.json({ error: automationHint(e) }, { status: 500 });
  } finally {
    client.release();
  }
}

// DELETE /api/sequences/:id — blocked if a campaign still references it.
export async function DELETE(_req, { params }) {
  const { id } = await params;
  const sequenceId = parseInt(id, 10);
  if (!sequenceId) {
    return Response.json({ error: "Invalid sequence id." }, { status: 400 });
  }
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM campaigns WHERE sequence_id = $1`,
      [sequenceId]
    );
    if (rows[0].n > 0) {
      return Response.json(
        { error: "This sequence is used by a campaign. Delete or repoint the campaign first." },
        { status: 409 }
      );
    }
    const { rowCount } = await pool.query(`DELETE FROM sequences WHERE id = $1`, [sequenceId]);
    if (rowCount === 0) {
      return Response.json({ error: "Sequence not found." }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: automationHint(e) }, { status: 500 });
  }
}
