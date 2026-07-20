import { pool } from "@/lib/db";

// Always run at request time — this reads from Postgres, so it must never be
// evaluated during the build.
export const dynamic = "force-dynamic";

// GET /api/contacts
// Returns every saved contact that has a usable email address, so the UI can
// list them and let the user email one or a range of them.
export async function GET() {
  try {
    const { rows } = await pool.query(
      `SELECT id, apollo_id, name, title, company, email, industry,
              website_url, created_at
       FROM contacts
       WHERE email IS NOT NULL
         AND email <> ''
         AND email NOT ILIKE '%not_unlocked%'
       ORDER BY id ASC`
    );

    return Response.json({ contacts: rows, total: rows.length });
  } catch (e) {
    // The most common failure is the table not existing / bad DATABASE_URL.
    const message =
      /relation .*contacts.* does not exist/i.test(e.message)
        ? "The `contacts` table does not exist in this database. Point DATABASE_URL at the same DB the apollo-people-app writes to (and run its `npm run db:setup`)."
        : e.message;
    return Response.json({ error: message }, { status: 500 });
  }
}
