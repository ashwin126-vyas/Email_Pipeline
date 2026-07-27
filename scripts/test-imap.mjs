// Verify the reply mailbox is reachable BEFORE letting the worker touch it.
//
//   npm run imap:test
//
// Deliberately READ-ONLY: it opens the mailbox with readOnly:true and never adds
// the \Seen flag, so running it can't consume replies the worker hasn't yet
// processed. (reply-scan.mjs only ever fetches UNSEEN messages and marks them
// seen — anything marked read before it polls is skipped forever.)

import { ImapFlow } from "imapflow";

const need = ["IMAP_HOST", "IMAP_USER", "IMAP_PASS"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`✗ Not configured — missing/empty: ${missing.join(", ")}`);
  console.error("  Reply scanning stays dormant until all three are set in .env.");
  process.exit(1);
}

const host = process.env.IMAP_HOST;
const port = parseInt(process.env.IMAP_PORT || "993", 10);
const mailbox = process.env.IMAP_MAILBOX || "INBOX";

console.log(`Connecting to ${host}:${port} as ${process.env.IMAP_USER} …`);

const client = new ImapFlow({
  host,
  port,
  secure: process.env.IMAP_TLS !== "false",
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
  logger: false,
});

try {
  await client.connect();
  console.log("✓ Connected and authenticated.");
} catch (e) {
  console.error(`✗ Login failed: ${e.message}`);
  console.error("  Common causes: wrong password; outreach@ is an alias rather than");
  console.error("  a real mailbox; or the host requires an app-specific password.");
  process.exit(1);
}

try {
  const boxes = await client.list();
  console.log(`\nMailboxes visible: ${boxes.map((b) => b.path).join(", ")}`);

  const lock = await client.getMailboxLock(mailbox, { readOnly: true });
  try {
    const status = await client.status(mailbox, { messages: true, unseen: true });
    console.log(`\n${mailbox}: ${status.messages} total, ${status.unseen} unseen`);

    const uids = await client.search({ seen: false }, { uid: true });
    const n = uids?.length || 0;
    console.log(`Unseen the worker would pick up on its next scan: ${n}`);
    if (n > 0) {
      console.log("\nFrom / subject of those (nothing is marked read by this script):");
      for await (const msg of client.fetch(uids.slice(0, 10), { envelope: true }, { uid: true })) {
        const from = msg.envelope?.from?.[0]?.address || "?";
        console.log(`  • ${from} — ${msg.envelope?.subject || "(no subject)"}`);
      }
    }
  } finally {
    lock.release();
  }
  console.log("\n✓ Mailbox readable. Reply scanning will activate on the next `npm run worker`.");
} catch (e) {
  console.error(`✗ Could not read ${mailbox}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => {});
}
