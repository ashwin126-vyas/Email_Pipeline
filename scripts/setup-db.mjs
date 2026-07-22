import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";

// Applies schema.sql (the email_templates + email_logs tables this app owns).
// Run with: npm run db:setup   (which passes --env-file=.env)

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (run via `npm run db:setup`).");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const sql = await readFile(join(root, "schema.sql"), "utf8");
  await pool.query(sql);

  const target = new URL(process.env.DATABASE_URL);
  console.log(`Applied schema.sql to ${target.pathname.slice(1)}`);

  const tables = [
    "email_templates",
    "email_logs",
    "sequences",
    "sequence_steps",
    "campaigns",
    "enrollments",
    "suppressions",
  ];
  for (const table of tables) {
    const { rows } = await pool.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );
    console.log(`\n${table}:`);
    console.table(rows);
  }
} catch (err) {
  console.error("Schema setup failed:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
