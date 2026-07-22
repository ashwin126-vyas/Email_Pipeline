// Quick check that the AI reply classifier is wired up and your key works —
// without needing the IMAP mailbox. Run:
//
//   node --env-file=.env scripts/test-classify.mjs
//   node --env-file=.env scripts/test-classify.mjs "your own reply text here"
//
// With ANTHROPIC_API_KEY set it prints the label Claude assigns each reply.
// Without it, it shows the "any reply -> stop" fallback the worker would use.

import { classifyReply } from "../src/lib/classify.js";

const custom = process.argv.slice(2).join(" ").trim();

const samples = custom
  ? [{ subject: "Re: your email", body: custom }]
  : [
      { subject: "Re: quick question", body: "Sure, this sounds interesting — can you send me pricing and maybe grab 15 min this week?" },
      { subject: "Re: quick question", body: "Please remove me from your list and don't email me again." },
      { subject: "Automatic reply: Out of office", body: "I'm on leave until Aug 4 with no email access. For urgent matters contact my colleague." },
      { subject: "Re: quick question", body: "Not interested, we already have a vendor for this. Thanks." },
    ];

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
console.log(hasKey ? "ANTHROPIC_API_KEY is set — classifying with Claude.\n" : "No ANTHROPIC_API_KEY — showing the no-AI fallback.\n");

for (const s of samples) {
  const result = await classifyReply(s);
  const label = result?.label ?? null;
  // Mirror what worker/reply-scan.mjs would do with this label.
  const action =
    label === "out_of_office"
      ? "DEFER a few days (keep sequencing)"
      : label === "unsubscribe"
      ? "STOP + suppress (unsubscribed)"
      : label === "interested"
      ? "STOP + suppress + ⭐ flag for human"
      : label
      ? "STOP + suppress (replied)"
      : "STOP + suppress (replied)  [fallback: any reply → stop]";

  console.log(`• "${s.body.slice(0, 60)}${s.body.length > 60 ? "…" : ""}"`);
  console.log(`    label:  ${label ?? "(none — AI unavailable)"}`);
  console.log(`    action: ${action}\n`);
}

console.log("Done. Wire IMAP_* (see .env.example) to run this automatically on real replies.");
