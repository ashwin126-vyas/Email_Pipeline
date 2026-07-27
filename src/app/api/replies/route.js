import { pool } from "@/lib/db";
import { recordReply } from "@/lib/replies";

export const dynamic = "force-dynamic";

// GET /api/replies?limit=&classification=&unhandled=1
// Newest-first list of stored replies, joined to contacts for the contact's
// CURRENT company/title and to campaigns for the campaign name.
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "200", 10) || 200, 1), 1000);
  const classification = searchParams.get("classification");
  const unhandled = searchParams.get("unhandled") === "1";

  const where = [];
  const values = [];
  if (classification) {
    values.push(classification);
    where.push(`r.classification = $${values.length}`);
  }
  if (unhandled) where.push("r.handled_at IS NULL");
  values.push(limit);

  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.apollo_id, r.email, r.subject, r.body, r.classification,
              r.action_taken, r.received_at, r.handled_at, r.handled_by,
              r.campaign_id, r.enrollment_id,
              c.name, c.company, c.title,
              cam.name AS campaign_name
         FROM email_replies r
         LEFT JOIN contacts c    ON c.apollo_id = r.apollo_id
         LEFT JOIN campaigns cam ON cam.id = r.campaign_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY r.received_at DESC
        LIMIT $${values.length}`,
      values
    );
    return Response.json({ replies: rows, total: rows.length });
  } catch (e) {
    const message = /relation .*email_replies.* does not exist/i.test(e.message)
      ? "The `email_replies` table does not exist. Run `npm run db:setup`."
      : e.message;
    return Response.json({ error: message }, { status: 500 });
  }
}

// POST /api/replies
// Body: { email, subject?, body?, message_id?, classify? }
//
// Saves one inbound reply. The sender must already exist in `contacts` — this is
// what keeps unrelated mail out of the table, so an unknown address is a 422
// rather than a silent no-op. If the contact still has a running sequence, the
// reply also stops it (or defers it, for out-of-office), exactly as an automated
// scan would have.
export async function POST(req) {
  let body = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const email = String(body.email || "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "A valid `email` (the sender) is required." }, { status: 400 });
  }
  if (!body.body && !body.subject) {
    return Response.json({ error: "Provide at least a `subject` or a `body`." }, { status: 400 });
  }

  try {
    const result = await recordReply({
      email,
      subject: body.subject || "",
      body: body.body || "",
      messageId: body.message_id || null,
      classify: body.classify !== false,
    });

    if (!result.stored) {
      return Response.json({ error: result.reason }, { status: 422 });
    }
    return Response.json(result);
  } catch (e) {
    const message = /relation .*email_replies.* does not exist/i.test(e.message)
      ? "The `email_replies` table does not exist. Run `npm run db:setup`."
      : e.message;
    return Response.json({ error: message }, { status: 500 });
  }
}
