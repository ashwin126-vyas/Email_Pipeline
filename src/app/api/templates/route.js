import { pool } from "@/lib/db";

// This reads/writes at request time — never evaluate during the build.
export const dynamic = "force-dynamic";

// GET /api/templates — list saved templates, newest first.
export async function GET() {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, subject, body, created_at, updated_at
       FROM email_templates
       ORDER BY updated_at DESC`
    );
    return Response.json({ templates: rows, total: rows.length });
  } catch (e) {
    return Response.json({ error: templateTableHint(e) }, { status: 500 });
  }
}

// POST /api/templates — create a template. Body: { name, subject, body }
export async function POST(req) {
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
      `INSERT INTO email_templates (name, subject, body)
       VALUES ($1, $2, $3)
       RETURNING id, name, subject, body, created_at, updated_at`,
      [name, subject, html]
    );
    return Response.json({ template: rows[0] }, { status: 201 });
  } catch (e) {
    return Response.json({ error: templateTableHint(e) }, { status: 500 });
  }
}

export function templateTableHint(e) {
  return /relation .*email_templates.* does not exist/i.test(e.message)
    ? "The `email_templates` table does not exist yet. Run `npm run db:setup`."
    : e.message;
}
