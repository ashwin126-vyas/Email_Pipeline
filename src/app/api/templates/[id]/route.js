import { pool } from "@/lib/db";
import { templateTableHint } from "../route";

export const dynamic = "force-dynamic";

// PUT /api/templates/:id — update a template. Body: { name, subject, body }
export async function PUT(req, { params }) {
  const { id } = await params;
  const templateId = parseInt(id, 10);
  if (!templateId) {
    return Response.json({ error: "Invalid template id." }, { status: 400 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = (body.name || "").trim();
  const subject = (body.subject || "").trim();
  const html = (body.body || "").trim();
  if (!name || !subject || !html) {
    return Response.json(
      { error: "name, subject and body are all required." },
      { status: 400 }
    );
  }

  try {
    const { rows } = await pool.query(
      `UPDATE email_templates
       SET name = $1, subject = $2, body = $3, updated_at = now()
       WHERE id = $4
       RETURNING id, name, subject, body, created_at, updated_at`,
      [name, subject, html, templateId]
    );
    if (rows.length === 0) {
      return Response.json({ error: "Template not found." }, { status: 404 });
    }
    return Response.json({ template: rows[0] });
  } catch (e) {
    return Response.json({ error: templateTableHint(e) }, { status: 500 });
  }
}

// DELETE /api/templates/:id
export async function DELETE(_req, { params }) {
  const { id } = await params;
  const templateId = parseInt(id, 10);
  if (!templateId) {
    return Response.json({ error: "Invalid template id." }, { status: 400 });
  }

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM email_templates WHERE id = $1`,
      [templateId]
    );
    if (rowCount === 0) {
      return Response.json({ error: "Template not found." }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: templateTableHint(e) }, { status: 500 });
  }
}
