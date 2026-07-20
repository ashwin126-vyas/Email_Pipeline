import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

// DELETE /api/sends/:id — remove a single row from the send log.
// This only deletes the history entry; it does not (and cannot) unsend the email.
export async function DELETE(_req, { params }) {
  const { id } = await params;
  const sendId = parseInt(id, 10);
  if (!sendId) {
    return Response.json({ error: "Invalid send id." }, { status: 400 });
  }

  try {
    const { rowCount } = await pool.query(`DELETE FROM email_sends WHERE id = $1`, [sendId]);
    if (rowCount === 0) {
      return Response.json({ error: "Send not found." }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    const message = /relation .*email_sends.* does not exist/i.test(e.message)
      ? "The `email_sends` table does not exist yet. Run `npm run db:setup`."
      : e.message;
    return Response.json({ error: message }, { status: 500 });
  }
}
