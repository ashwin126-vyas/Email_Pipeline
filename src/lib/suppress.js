// Shared do-not-contact helpers. Used by /api/unsubscribe, /api/brevo-webhook
// and the worker's reply detection. `q` is anything with a .query() — the shared
// pool or a transaction client.

// Add an address (and/or apollo_id) to the global suppression list. Idempotent
// on lower(email) via the unique index. Suppressing is always safe to repeat.
export async function addSuppression(q, { email, apolloId, reason }) {
  const addr = (email || "").trim().toLowerCase();
  if (!addr && !apolloId) return;
  await q.query(
    `INSERT INTO suppressions (apollo_id, email, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (lower(email)) DO NOTHING`,
    [apolloId || null, addr || null, reason]
  );
}

// Stop every still-active enrollment for a contact (matched by email via the
// `contacts` table, or directly by apollo_id) so the heartbeat won't send them
// another step. `status` is the terminal state (replied|unsubscribed|bounced).
export async function stopEnrollments(q, { email, apolloId, status }) {
  const addr = (email || "").trim().toLowerCase();
  await q.query(
    `UPDATE enrollments e
        SET status = $1, updated_at = now()
      WHERE e.status = 'active'
        AND (
              ($2::text IS NOT NULL AND e.apollo_id = $2)
           OR ($3::text IS NOT NULL AND e.apollo_id IN (
                 SELECT apollo_id FROM contacts WHERE lower(email) = $3
              ))
        )`,
    [status, apolloId || null, addr || null]
  );
}

// True if this address is on the suppression list.
export async function isSuppressed(q, email) {
  const addr = (email || "").trim().toLowerCase();
  if (!addr) return false;
  const { rows } = await q.query(
    `SELECT 1 FROM suppressions WHERE lower(email) = $1 LIMIT 1`,
    [addr]
  );
  return rows.length > 0;
}
