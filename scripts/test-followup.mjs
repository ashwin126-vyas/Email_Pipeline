// Watch a REAL follow-up sequence land in your own inbox. Sends a 3-step
// AI-written sequence (initial + 2 follow-ups) to ONE address with a short gap
// between steps — so you can see follow-ups actually arrive, instead of waiting
// the campaign's real 48h/72h. Uses your AI provider to write it and Brevo to
// send it. These are REAL emails — send them to YOUR OWN address.
//
//   npm run test:followup you@example.com          # 120s between steps
//   npm run test:followup you@example.com 60        # 60s between steps
//
// Note: this test sends all 3 steps regardless — it's a delivery/timing demo.
// The real worker additionally STOPS the follow-ups the moment you reply.

import { pool } from "../src/lib/db.js";
import { sendEmail, renderTemplate } from "../src/lib/brevo.js";
import { htmlFromBody } from "../src/lib/htmlBody.js";
import { generateSequence } from "../src/lib/generateSequence.js";
import { appendUnsubscribeFooter, unsubscribeHeaders } from "../src/lib/unsubscribe.js";

const to = process.argv[2];
const delaySec = parseInt(process.argv[3] || "120", 10) || 120;
if (!to) {
  console.error("Usage: npm run test:followup <email> [delaySeconds]");
  process.exit(1);
}

// A demo recipient so {{first_name}}/{{company}} render; mail goes to `to`.
const contact = { name: "Ashwin", company: "Advanced Analytics", title: "Founder" };

console.log(`Writing a 3-step sequence with your AI provider…`);
const seq = await generateSequence({
  productPitch:
    "RadiusAI is an AI placement platform: an ATS-friendly CV builder, a cover-letter/email generator, and a dashboard that gives universities placement insights to get students job-ready faster.",
  targetDescription: `${contact.title} at ${contact.company}`,
  tone: "warm, concise",
  steps: 3,
});
if (seq.error) {
  console.error("Generation failed:", seq.error);
  process.exit(1);
}

// Throwaway campaign so each log row carries a real campaign name + step number
// (exactly like a real campaign would). Left in place so the Sent-log joins
// resolve — delete "TEST — Follow-up demo" from the Campaigns tab when done.
const seqId = (await pool.query(`INSERT INTO sequences (name) VALUES ('TEST — Follow-up demo') RETURNING id`)).rows[0].id;
const campId = (
  await pool.query(
    `INSERT INTO campaigns (name, sequence_id, status) VALUES ('TEST — Follow-up demo', $1, 'draft') RETURNING id`,
    [seqId]
  )
).rows[0].id;

console.log(`Sending ${seq.steps.length} steps to ${to}, ${delaySec}s apart.`);
console.log(`Logging under campaign "TEST — Follow-up demo" (#${campId}).\n`);
for (let i = 0; i < seq.steps.length; i++) {
  const step = seq.steps[i];
  const subject = renderTemplate(step.subject, contact);
  const bodyText = renderTemplate(step.body, contact);
  const footer = appendUnsubscribeFooter(htmlFromBody(bodyText), bodyText, to, { c: "demo" });
  const r = await sendEmail({
    to,
    toName: contact.name,
    subject,
    html: footer.html,
    text: footer.text,
    headers: unsubscribeHeaders(to, { c: "demo" }),
  });
  const label = i === 0 ? "INITIAL " : `FOLLOW-UP ${i}`;
  console.log(
    `${new Date().toLocaleTimeString()} — ${label} → ${r.ok ? "sent ✓" : "FAILED: " + r.error}  |  "${subject}"`
  );
  await pool
    .query(
      `INSERT INTO email_logs
         (email,name,company,subject,body,status,message_id,error,template_id,campaign_id,step_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10)`,
      [to, contact.name, contact.company, subject, bodyText, r.ok ? "sent" : "failed", r.ok ? r.messageId : null, r.ok ? null : r.error, campId, i + 1]
    )
    .catch(() => {});

  if (i < seq.steps.length - 1) {
    console.log(`   …waiting ${delaySec}s for the next follow-up…\n`);
    await new Promise((res) => setTimeout(res, delaySec * 1000));
  }
}

console.log(`\nDone. Check ${to} — you should have the initial email + 2 follow-ups (check spam too).`);
await pool.end();
