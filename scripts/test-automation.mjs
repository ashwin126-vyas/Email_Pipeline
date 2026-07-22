// Proves the automation LOOP works — end to end, in seconds, WITHOUT sending any
// real email. It spins up a throwaway 3-step campaign targeting one real
// contact, then runs the worker's real tick in dry-run mode several times,
// forcing each step "due" so you can watch a contact walk step 1 -> 2 -> 3 ->
// completed. Cleans up everything afterward.
//
//   npm run test:automation
//
// Safe to run against your live DB: WORKER_DRY_RUN short-circuits the Brevo call,
// and the pass is restricted to this test's own campaign.

process.env.WORKER_DRY_RUN = "true"; // set BEFORE importing the engine

const { pool } = await import("../src/lib/db.js");
const { runTick } = await import("../worker/engine.mjs");

const line = (s = "") => console.log(s);

async function enrollmentState(campaignId) {
  const { rows } = await pool.query(
    `SELECT current_step, status, next_action_at
       FROM enrollments WHERE campaign_id = $1`,
    [campaignId]
  );
  return rows[0];
}

let seqId, campId;
try {
  // 0. Need a template and at least one real contact to point at.
  const tpl = (await pool.query(`SELECT id, name FROM email_templates ORDER BY id LIMIT 1`)).rows[0];
  if (!tpl) throw new Error("No templates found — create one on the Recipients page first.");
  const contact = (
    await pool.query(
      `SELECT apollo_id, name, email FROM contacts
        WHERE email IS NOT NULL AND email <> '' AND email NOT ILIKE '%not_unlocked%'
        ORDER BY id LIMIT 1`
    )
  ).rows[0];
  if (!contact) throw new Error("No usable contacts found in the DB.");
  line(`Using template "${tpl.name}" and 1 contact (${contact.email}).`);
  line(`WORKER_DRY_RUN is on — no real email will be sent.\n`);

  // 1. Throwaway sequence: 3 steps (delays don't matter, we force "due" each tick).
  seqId = (await pool.query(`INSERT INTO sequences (name) VALUES ('__test_automation__') RETURNING id`)).rows[0].id;
  for (const [n, delay] of [[1, 0], [2, 48], [3, 72]]) {
    await pool.query(
      `INSERT INTO sequence_steps (sequence_id, step_number, delay_hours, template_id) VALUES ($1,$2,$3,$4)`,
      [seqId, n, delay, tpl.id]
    );
  }

  // 2. Throwaway ACTIVE campaign, window always open, targeting just this contact.
  campId = (
    await pool.query(
      `INSERT INTO campaigns
         (name, sequence_id, target_filter, daily_cap, window_start, window_end, timezone, status)
       VALUES ('__test_automation__', $1, $2, 1000, 0, 24, 'UTC', 'active') RETURNING id`,
      [seqId, JSON.stringify({ apollo_ids: [contact.apollo_id] })]
    )
  ).rows[0].id;

  // 3. Enroll the contact (step 1, due now).
  await pool.query(
    `INSERT INTO enrollments (campaign_id, apollo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [campId, contact.apollo_id]
  );
  line(`Enrolled. Initial state: ${JSON.stringify(await enrollmentState(campId))}\n`);

  // 4. Run the REAL worker tick repeatedly. Before each, force next_action_at=now
  //    to simulate the follow-up delay elapsing, so we see the whole sequence fast.
  for (let i = 1; i <= 4; i++) {
    await pool.query(
      `UPDATE enrollments SET next_action_at = now() WHERE campaign_id = $1 AND status = 'active'`,
      [campId]
    );
    const summary = await runTick({ onlyCampaignId: campId });
    const st = await enrollmentState(campId);
    line(`tick ${i}: sent ${summary.sent} → enrollment now step=${st.current_step} status=${st.status}`);
  }

  // 5. Show the (dry-run) send log the engine wrote.
  const sends = (
    await pool.query(
      `SELECT subject, status, message_id FROM email_logs WHERE campaign_id = $1 ORDER BY sent_at`,
      [campId]
    )
  ).rows;
  line(`\nLogged ${sends.length} send(s) to email_logs:`);
  sends.forEach((s, i) => line(`  ${i + 1}. [${s.status}] ${s.message_id} — "${s.subject}"`));

  const finalStatus = (await enrollmentState(campId))?.status;
  line(
    finalStatus === "completed"
      ? `\n✅ PASS — the contact advanced through all 3 steps and the sequence completed.`
      : `\n⚠️  Ended in status "${finalStatus}" (expected "completed").`
  );
} catch (e) {
  line(`\n❌ ${e.message}`);
  process.exitCode = 1;
} finally {
  // 6. Clean up everything this test created.
  if (campId) {
    await pool.query(`DELETE FROM email_logs WHERE campaign_id = $1`, [campId]).catch(() => {});
    await pool.query(`DELETE FROM campaigns WHERE id = $1`, [campId]).catch(() => {}); // cascades enrollments
  }
  if (seqId) await pool.query(`DELETE FROM sequences WHERE id = $1`, [seqId]).catch(() => {});
  line(`Cleaned up test campaign/sequence.`);
  await pool.end();
}
