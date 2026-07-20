import { Pool } from "pg";

// Single shared pool, reused across hot reloads in dev (Next re-imports modules
// on every change, which would otherwise leak a new pool each time).
const globalForPg = globalThis;

export const pool =
  globalForPg._emailAppPool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
  });

if (!globalForPg._emailAppPool) {
  globalForPg._emailAppPool = pool;
}
