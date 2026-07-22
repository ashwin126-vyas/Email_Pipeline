// The automation worker — a long-running process, NOT a Next route.
// Run it alongside the app:  npm run worker  (node --env-file=.env worker/index.mjs)
//
// Two timers:
//   • send tick  (SEND_INTERVAL_MINUTES, default 2) — the heartbeat: send who's
//     due, advance follow-ups. See worker/engine.mjs.
//   • reply scan (REPLY_INTERVAL_MINUTES, default 5) — poll the reply mailbox and
//     stop anyone who answered. Dormant unless IMAP_* is configured.
//
// A single in-process lock per timer prevents overlapping runs (SKIP LOCKED in
// the DB additionally guards against two separate worker processes).

import cron from "node-cron";
import { runTick } from "./engine.mjs";
import { scanReplies, replyScanEnabled } from "./reply-scan.mjs";

const now = () => new Date().toISOString();
function log(...a) {
  console.log(`[worker ${now()}]`, ...a);
}

const SEND_INTERVAL = parseInt(process.env.SEND_INTERVAL_MINUTES || "2", 10) || 2;
const REPLY_INTERVAL = parseInt(process.env.REPLY_INTERVAL_MINUTES || "5", 10) || 5;

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

const replyTick = guarded("reply-scan", async () => {
  await scanReplies();
});

log(`starting. send every ${SEND_INTERVAL}m, reply scan ${replyScanEnabled() ? `every ${REPLY_INTERVAL}m` : "DISABLED (no IMAP_* set)"}.`);
if (!process.env.DATABASE_URL) {
  log("WARNING: DATABASE_URL is not set — did you run via `npm run worker` (which passes --env-file=.env)?");
}

// node-cron expressions. */n minutes.
cron.schedule(`*/${SEND_INTERVAL} * * * *`, sendTick);
if (replyScanEnabled()) {
  cron.schedule(`*/${REPLY_INTERVAL} * * * *`, replyTick);
}

// Kick one pass immediately on boot so we don't wait a full interval.
sendTick();
if (replyScanEnabled()) replyTick();

// Graceful shutdown so the process manager can restart us cleanly.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} received — shutting down.`);
    process.exit(0);
  });
}
