// The automation worker — a long-running process, NOT a Next route.
// Run it alongside the app:  npm run worker  (node --env-file=.env worker/index.mjs)
//
// One timer:
//   • send tick  (SEND_INTERVAL_MINUTES, default 2) — the heartbeat: send who's
//     due, advance follow-ups. See worker/engine.mjs.
//
// There is NO reply polling. Nothing here reads a mailbox, so a contact who
// replies is not detected and their sequence is NOT stopped automatically —
// replies reach the DB only when something calls POST /api/replies (see
// src/lib/replies.js). Recording a reply there still stops the sequence.
//
// A single in-process lock prevents overlapping runs (SKIP LOCKED in the DB
// additionally guards against two separate worker processes).

import cron from "node-cron";
import { runTick } from "./engine.mjs";

const now = () => new Date().toISOString();
function log(...a) {
  console.log(`[worker ${now()}]`, ...a);
}

const SEND_INTERVAL = parseInt(process.env.SEND_INTERVAL_MINUTES || "2", 10) || 2;

// Guard so a long tick never overlaps the next scheduled fire.
function guarded(name, fn) {
  let running = false;
  return async () => {
    if (running) {
      log(`${name}: previous run still going, skipping this tick`);
      return;
    }
    running = true;
    try {
      await fn();
    } catch (e) {
      log(`${name} crashed:`, e.stack || e.message);
    } finally {
      running = false;
    }
  };
}

const sendTick = guarded("send-tick", async () => {
  const summary = await runTick();
  if (summary.sent > 0) log(`tick done: ${summary.sent} sent across ${summary.campaigns} active campaign(s)`);
});

log(`starting. send every ${SEND_INTERVAL}m. Reply polling: NOT INSTALLED — follow-ups do not stop on reply.`);
if (!process.env.DATABASE_URL) {
  log("WARNING: DATABASE_URL is not set — did you run via `npm run worker` (which passes --env-file=.env)?");
}

// node-cron expression. */n minutes.
cron.schedule(`*/${SEND_INTERVAL} * * * *`, sendTick);

// Kick one pass immediately on boot so we don't wait a full interval.
sendTick();

// Graceful shutdown so the process manager can restart us cleanly.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} received — shutting down.`);
    process.exit(0);
  });
}
