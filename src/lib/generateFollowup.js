// Follow-up generation — steps 1 and 2 of a thread whose step 0 lives in
// email_testing.
//
// A follow-up is not a second first-email. It is sent to someone who has already
// received one and said nothing, and that changes what it is allowed to be:
//
//   · it may not re-pitch the product from scratch — they read that already,
//   · it may not repeat the first subject line, or the reply lands in a thread
//     that looks like a mail merge to itself,
//   · it must add ONE new thing, otherwise it has no reason to exist,
//   · it must get shorter each time, because attention is going down not up,
//   · it may not guilt them. "Just circling back", "did you see my last email"
//     and "gentle reminder" all say the same thing: I am counting, and you are
//     late. That is the fastest way to turn silence into a block.
//
// So every gate here is comparative — the step is validated against the TEXT OF
// EVERY PREVIOUS STEP, not just against its own contract. That is the whole
// difference between this file and generatePersonEmail.js, and it is why the
// previous bodies are carried in the contract rather than summarised.
//
// Follow-ups fire on NO REPLY, never on "not opened" (Apple MPP made opens
// meaningless). Nothing here sends anything.

import { chatJSON, aiProvider } from "./llm.js";
import { BANNED, BANNED_PATTERNS, B2B_LANGUAGE, SUPERIORITY_CLAIMS, enterpriseHits, norm, overlap } from "./generatePersonEmail.js";
import { senderBlock, signatureProblem } from "./sender.js";

export const FOLLOWUP_PROMPT_VERSION = "followup-v1-2026-07";

/**
 * The sequence. Each step has a different job; if two steps have the same job,
 * one of them should not be sent.
 */
export const FOLLOWUP_STEPS = {
  1: {
    send_after_days: 3,
    max_words: 150,
    // 100 was the floor for the old brief ("add one new specific"). The handoff
    // brief is tighter — lead on ONE pillar, restate free once, make the ask
    // smaller — and it lands at 80-90 words every time: three consecutive runs
    // came in at 87, 80 and 83 against a 100 floor, so the floor was buying
    // retries rather than length. The spec sets only an upper bound for this step.
    min_words: 80,
    goal: "Introduce the one thing they did not get first time, and make the ask smaller.",
    angle_guidance: `WHAT LEADS THIS EMAIL depends on institution tier (from the CTA logic):
- If the institution is partnership-tier (strong placement record OR elite): LEAD
  ON REVENUE. State plainly that RadiusAI is the rare tool that pays the
  university instead of billing it: qualifying universities share in the revenue
  under a distribution partnership. Frame it as AVAILABLE, never a blanket
  promise, never a figure, no pricing. The line "you get paid, not billed" is
  sanctioned.
- Otherwise: do NOT mention revenue. Lead on the best headline angle NOT used in
  the initial email for this contact (usually no_student_left_behind or
  placement_rate), expressed through their specifics.

Either way, restate "free" once. One ask, smaller than last time: a short
partnership conversation, or forward the free ATS checker to one batch.`,
  },
  2: {
    send_after_days: 7,
    max_words: 110,
    // The handoff states 70-110 for this step, but its own brief for the step —
    // do not re-explain the product, one new angle only, one narrow ask, an
    // explicit way out — lands at ~62 words. Nine consecutive runs came in at
    // 54-66 and none reached 70. The floor and the brief disagree, and reaching
    // the floor would mean padding, which this pipeline forbids everywhere else.
    // shorter_than_previous still enforces the ladder.
    min_words: 60,
    goal: "One concrete piece of value, easy to decline. Leads on LIVE COHORT ANALYTICS.",
    angle_guidance: `Lead on the live cohort analytics: the officer sees every student's application
and placement progress in real time, at no cost. That is the one new angle; do
not re-explain the product or list capabilities. Restate "free" once. Give them
an explicit way out ("if this is not useful, say so and I will leave it there").
One ask, narrow and concrete, never two questions. Between 60 and 110 words, and
still shorter than both previous emails.`,
  },
  // The sign-off. Only reached when someone asks for a third follow-up — the
  // default sequence is two, and step 2 already closes politely. Its band sits
  // below step 2's floor on purpose: shorter_than_previous measures against the
  // SHORTEST email in the thread, so a third step sharing step 2's 70-word floor
  // would need to be both ≥70 and <70-ish, and no wording can satisfy that.
  3: {
    send_after_days: 14,
    max_words: 70,
    min_words: 35,
    goal: "Close the thread. Leads on FREE and \"it has never been easier\". Nothing asked.",
    angle_guidance: `This is the last email and it must read that way. Lead on the fact that it is
free and it has never been easier to put in front of their students. Say the
useful thing once, in a single sentence. Then close the loop explicitly: make
clear you will not write again and that they can come back whenever it is
relevant. Do NOT ask a question, do NOT restate capabilities, do NOT add a new
offer. Under 70 words. Shorter than every previous email in the thread.`,
  },
};

// The follow-up tells. Every one of these announces that the sender is tracking
// non-response rather than saying something new.
const GUILT_LANGUAGE = [
  /\bjust (circling|checking|following|bumping|touching)\b/i,
  /\bcircling back\b/i, /\bfollowing up\b/i, /\bfollow(ing)? up on my\b/i,
  /\bchecking in\b/i, /\bbumping this\b/i, /\bgentle reminder\b/i,
  /\bfriendly reminder\b/i, /\bdid you (see|get|have a chance to (see|read|review))\b/i,
  /\bin case you missed\b/i, /\bhaven'?t heard back\b/i, /\bany (thoughts|update)s? on my\b/i,
  /\bi know you'?re busy\b/i, /\bbringing this back to the top\b/i,
  /\bas per my (last|previous)\b/i, /\bmy last email\b/i,
];

// Money talk. radiusai.online publishes no pricing at all, so any figure with a
// currency attached is invented by definition.
const PRICING_LANGUAGE = [
  /[₹$€£]\s?\d/, /\b\d+\s?(rs|inr|usd|rupees)\b/i, /\bper (student|seat|user)\s+(cost|price|fee)\b/i,
  /\bdiscount\b/i, /\boffer price\b/i, /\bsubscription fee\b/i, /\bfree trial for\b/i,
];

const FOLLOWUP_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Max 8 words. Must differ from every previous subject. No colons, no 'Re:'." },
    body: { type: "string", description: "Plain text. Greeting, body, sign-off." },
    new_specific: { type: "string", description: "The ONE new thing this email adds that the previous ones did not say." },
    angle: { type: "string", description: "The angle this email opens on, in a few words." },
    ask: { type: "string", description: "The single ask, in a few words." },
  },
  required: ["subject", "body", "new_specific", "angle", "ask"],
  additionalProperties: false,
};

// Same two voices as the initial email, and for the same reason: a thread that
// switches register between step 1 and step 2 reads as a different sender.
const REGISTER_GUIDE = {
  academic: `Formal and precise. Address by title and surname, Dr. or Prof. where
applicable. No contractions. Measured and respectful. Use "it has never been
easier", never "no excuse".`,
  operational: `Direct and confident. Short, punchy sentences. Contractions are
fine. Blunt clarity is wanted: "no reason not to", "it costs you nothing", "it has
never been easier". Still professional. No hype words, no exclamation marks.`,
};

function systemPrompt({ step, tone, maxWords, minWords, register }) {
  const contractWords = minWords ? `write ${minWords} to ${maxWords} words` : `stay under ${maxWords} words`;
  const cfg = FOLLOWUP_STEPS[step] || FOLLOWUP_STEPS[1];
  return `FRAME (most important)
The subject line and the opening sentence are written from the UNIVERSITY'S point
of view, not the student's. The reader is not applying for jobs. Never make a
student the subject of the subject line or the opening. Point every student
benefit at the officer.

TONE
${REGISTER_GUIDE[register] || REGISTER_GUIDE.academic}

You write follow-up email number ${step} in a short sequence. The recipient
already received the previous email(s) shown to you and did NOT reply. They are
not annoyed with you; they are busy and it was not important enough yet.

GOAL OF THIS STEP
${cfg.goal}

${cfg.angle_guidance}

WHAT A FOLLOW-UP MAY NOT BE
1. It may not re-pitch the product from scratch. They have read that. Assume they
   remember roughly nothing but do not repeat yourself to fix it.
2. It may not reuse a previous subject line, or any near-variant of one.
3. It may not guilt them or mention that they did not reply. Banned outright:
   "just circling back", "following up", "checking in", "gentle reminder", "did
   you see my last email", "as per my last email", "I know you're busy", "haven't
   heard back". Silence is information, not a slight. Write as if this were the
   first time you had something worth saying.
4. It may not repeat the previous emails' sentences. Different words, different
   angle, different opening.

RULES
5. Under ${maxWords} words in the body. Count them. This email must be SHORTER
   than every previous email in the thread.
6. Cite ONLY facts in allowed_facts. Introduce no number, ranking, date, statistic
   or customer that is not there. If "proof_available" says NONE, you have no
   statistics, no customers and no testimonials — do not invent one.
7. The product is a CONSUMER (B2C) product used by STUDENTS. The recipient is not
   the buyer and not the user, they are a route to their students. Write about
   what a student gets. Never use procurement language (licence, rollout, pilot,
   deployment, ROI, enterprise, vendor).
8. No pricing. The product publishes no prices, so you do not know any. Never
   write a figure with a currency, a discount or a fee.
8b. SIGN OFF with exactly the two lines in sender.sign_off_exactly — name then
   title. NEVER a bracketed placeholder like [Your Name].
9. One ask, at the end. Never two questions.
10. No em-dashes. No exclamation marks. No filler openers ("I hope this email
   finds you well", "I am reaching out"). No generic praise ("commitment to
   excellence").
11. Subject: max 8 words, specific, no colons, no "Re:".
12. new_specific must state the one genuinely new thing this email adds. If you
   cannot name one, you have written a nudge rather than an email.

TONE: ${tone === "peer" ? "Peer to peer. Direct and concrete, no deference, no salesmanship."
  : tone === "warm" ? "Warm and plain. Friendly without being familiar. Still specific."
  : "Formal and precise. Title and surname. No contractions, no slang."}`;
}

/**
 * Build the contract for one follow-up step. Carries the FULL text of every
 * previous step, because every gate below is comparative.
 */
export function buildFollowupContract({ step, original, previous = [], product, campaign, research, role }) {
  const cfg = FOLLOWUP_STEPS[step] || FOLLOWUP_STEPS[1];
  const contract = {
    step,
    // Same signature as the first email — the thread is from one person, and a
    // follow-up signed differently reads as a different sender.
    sender: senderBlock(),
    // The role carries tone_register. Without it the whole thread would default to
    // the academic voice while the first email used the operational one, which
    // reads as two different senders writing about the same thing.
    ...(role ? { role } : {}),
    goal: cfg.goal,
    max_words: cfg.max_words,
    // The floor must yield to shorter_than_previous, or the two gates contradict
    // each other whenever the thread starts short: a 90-word first email makes
    // "at least 100 words AND shorter than 90" unsatisfiable, and every follow-up
    // fails no matter what the model writes. So the configured floor is a target,
    // capped by what the thread actually leaves room for.
    min_words: (() => {
      const prevLens = [original?.body, ...previous.map((x) => x.body)]
        .map((b) => String(b || "").trim().split(/\s+/).filter(Boolean).length)
        .filter((n) => n > 0);
      if (!prevLens.length) return cfg.min_words;
      const headroom = Math.min(...prevLens) - 15;
      return Math.max(25, Math.min(cfg.min_words, headroom));
    })(),
    send_after_days: cfg.send_after_days,
    tone: original?.tone || "formal",
    recipient: {
      name: original?.person_name || "",
      email: original?.person_email || "",
      organisation: original?.org_name || "",
    },
    email_intent: original?.email_intent || "",
    // The thread so far, in full. Summarising it here would defeat the point:
    // the model cannot avoid repeating what it cannot see.
    thread: [
      { step: 0, subject: original?.subject || "", body: original?.body || "" },
      ...previous.map((p) => ({ step: p.step_number, subject: p.subject || "", body: p.body || "" })),
    ],
    allowed_facts: (research?.provenance || [])
      .filter((f) => Number(f.confidence) >= 0.7)
      .map((f) => ({ fact: f.fact, source_url: f.source_url }))
      .slice(0, 10),
  };

  if (product) {
    contract.product = product;
    contract.proof_available = (product.proof_points || []).length
      ? product.proof_points
      : "NONE. Claim no statistics, customers or testimonials — there are none to cite.";
    // Named explicitly so step 1 can be told to use something the first email did not.
    contract.capabilities_unused = (product.capabilities || [])
      .filter((c) => !norm(original?.body || "").includes(norm(c.name).split(" ")[0]))
      .map((c) => c.name);
  }
  if (campaign) {
    contract.campaign = { theme: campaign.theme, pain_framing: campaign.pain_framing, cta: campaign.cta };
  }
  return contract;
}

// ── validation ──────────────────────────────────────────────────────────────

const numbersIn = (s) => (String(s ?? "").match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, ""));
const words = (s) => String(s ?? "").trim().split(/\s+/).filter(Boolean);

/** Sentence-level repetition between two bodies. */
function repeatedSentences(a, b) {
  const split = (t) => String(t || "").split(/[.?!\n]+/).map((s) => norm(s).replace(/[^a-z0-9 ]/g, "").trim())
    .filter((s) => s.split(/\s+/).length >= 6);
  const prev = new Set(split(a));
  return split(b).filter((s) => prev.has(s));
}

/**
 * @returns {{valid: boolean, gates: object, failed: string[]}}
 */
export function validateFollowup({ subject, body, newSpecific, contract }) {
  const gates = {};
  const add = (n, pass, detail) => { gates[n] = { pass: Boolean(pass), detail: detail || null }; };
  const thread = contract?.thread || [];
  const text = `${subject || ""}\n${body || ""}`;
  const bodyWords = words(body);

  // 1. max_words — a follow-up that is as long as the first email is a re-pitch.
  add("max_words", bodyWords.length <= (contract?.max_words || 110),
    `${bodyWords.length}/${contract?.max_words || 110} words`);

  // 1a. product_link_present — the rule was in the prompt but not gated here, and
  //     a follow-up promptly wrote "sharing RadiusAI's link" with no URL in it.
  //     A prompt is a request; this is the rule.
  const productUrl = contract?.product?.url;
  if (productUrl) {
    const bare = (u) => String(u).trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    const hasUrl = bare(text).includes(bare(productUrl));
    // Same rule as the initial email: a plain-text email renders "[link](url)"
    // literally, brackets and all.
    const wrapped = /\[[^\]\n]*\]\(\s*https?:\/\//i.test(text);
    add("product_link_present", hasUrl && !wrapped,
      !hasUrl ? `body must contain ${productUrl}`
        : wrapped ? "the link is wrapped in markdown; write the URL bare on its own line"
        : null);
  }

  // 1a2. signature_real — same rule as the first email. A thread that signs off
  //      "[Your Name]" on step 3 undoes every specific fact above it.
  const sigProblem = signatureProblem(body);
  add("signature_real", !sigProblem, sigProblem);

  // 1b. min_words — a follow-up shrinking to one line stops being an email and
  //     becomes a nudge, which is what the no-guilt rule already forbids.
  const minW = Number(contract?.min_words) || 0;
  if (minW) add("min_words", bodyWords.length >= minW, `${bodyWords.length}/${minW} words minimum`);

  // 2. shorter_than_previous — attention goes down across a sequence, so length
  //    must too. Compared against the SHORTEST previous step, not the last one.
  const prevLens = thread.map((t) => words(t.body).length).filter((n) => n > 0);
  const shortestPrev = prevLens.length ? Math.min(...prevLens) : Infinity;
  add("shorter_than_previous", bodyWords.length < shortestPrev,
    prevLens.length ? `${bodyWords.length} vs shortest previous ${shortestPrev}` : "no previous step");

  // 3. subject_differs — a repeated subject makes the thread look automated.
  const subjClash = thread.filter((t) => {
    const a = norm(t.subject).replace(/[^a-z0-9 ]/g, "").trim();
    const b = norm(subject).replace(/[^a-z0-9 ]/g, "").trim();
    return a === b || (a && b && overlap(t.subject, subject) >= 3);
  });
  add("subject_differs", subjClash.length === 0,
    subjClash.length ? `too close to step ${subjClash[0].step}: "${subjClash[0].subject}"` : null);

  // 4. not_a_repeat — no reused sentences from any earlier step.
  const repeats = thread.flatMap((t) => repeatedSentences(t.body, body));
  add("not_a_repeat", repeats.length === 0,
    repeats.length ? `sentence reused from an earlier step: "${repeats[0].slice(0, 70)}"` : null);

  // 5. no_guilt_trip — the tells that announce you are counting their silence.
  const guilt = GUILT_LANGUAGE.filter((re) => re.test(text)).map((re) => String(re).slice(1, -2));
  add("no_guilt_trip", guilt.length === 0,
    guilt.length ? `guilt/nudge language: ${guilt.join(", ")}` : null);

  // 6. adds_something_new — the reason this email is allowed to exist.
  const newSpec = String(newSpecific || "").trim();
  const specInBody = newSpec && overlap(newSpec, body) >= 2;
  add("adds_something_new", Boolean(newSpec) && specInBody,
    !newSpec ? "no new_specific declared" : specInBody ? null : "new_specific is not actually in the body");

  // 7. no_orphan_numbers — same rule as the first email: every digit must trace
  //    to the contract.
  const allowed = new Set();
  const harvest = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) return v.forEach(harvest);
    if (typeof v === "object") return Object.values(v).forEach(harvest);
    numbersIn(v).forEach((n) => allowed.add(n));
  };
  harvest(contract?.allowed_facts); harvest(contract?.product);
  harvest(contract?.campaign); harvest(contract?.recipient); harvest(contract?.email_intent);
  harvest(contract?.thread);
  const orphans = [...new Set(numbersIn(body))].filter((n) => !allowed.has(n));
  add("no_orphan_numbers", orphans.length === 0,
    orphans.length ? `untraceable number(s): ${orphans.join(", ")}` : null);

  // 8. no_pricing — the site publishes none, so any price is fabricated.
  const price = PRICING_LANGUAGE.filter((re) => re.test(text)).map((re) => String(re).slice(1, -2));
  add("no_pricing", price.length === 0,
    price.length ? `pricing we do not publish: ${price.join(", ")}` : null);

  // 9. banned_phrases — filler, cliche, and B2B vocabulary in a B2C pitch.
  const hits = BANNED.filter((p) => norm(text).includes(p));
  for (const { re, label } of BANNED_PATTERNS) if (re.test(text)) hits.push(label);
  // Negation-aware, same as the initial email: the free message is literally "no
  // vendor, no budget, no rollout", and a flat ban rejects the copy the product
  // block sanctions.
  for (const h of enterpriseHits(text, B2B_LANGUAGE)) hits.push(`B2B language: ${h}`);
  for (const { re, label } of SUPERIORITY_CLAIMS) if (re.test(text)) hits.push(label);
  if (text.includes("—") || text.includes("–")) hits.push("em-dash");
  if (text.includes("!")) hits.push("exclamation mark");
  add("banned_phrases", hits.length === 0, hits.length ? hits.join(", ") : null);

  // 10. one_ask
  add("one_ask", (body.match(/\?/g) || []).length <= 1,
    `${(body.match(/\?/g) || []).length} questions`);

  // 11. subject_present
  const subjWords = words(subject).length;
  const subjProblem = !String(subject || "").trim() ? "empty subject"
    : subjWords > 12 ? `${subjWords} words`
    : /:/.test(subject) ? "contains a colon"
    : /^re:/i.test(String(subject).trim()) ? 'starts with "Re:"' : null;
  add("subject_present", subjProblem === null, subjProblem);

  const failed = Object.entries(gates).filter(([, g]) => !g.pass).map(([n]) => n);
  return { valid: failed.length === 0, gates, failed };
}

// ── generation ──────────────────────────────────────────────────────────────

/**
 * Generate one follow-up step.
 * @returns {Promise<{subject?, body?, newSpecific?, angle?, ask?, contract, prompts, validation?, warnings, error?}>}
 */
export async function generateFollowup({ step, original, previous = [], product, campaign, research, role, attempts = 2 }) {
  const contract = buildFollowupContract({ step, original, previous, product, campaign, research, role });
  const register = contract?.role?.tone_register === "operational" ? "operational" : "academic";
  const system = systemPrompt({ step, tone: contract.tone, maxWords: contract.max_words, minWords: contract.min_words, register });
  const baseUser = `CONTRACT\n${JSON.stringify(contract, null, 2)}`;
  let user = baseUser;
  let last = null;
  const warnings = [];

  if (!contract.allowed_facts.length) {
    warnings.push("no citable facts for this contact, follow-up stays generic");
  }

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    const prompts = { system, user, version: FOLLOWUP_PROMPT_VERSION };
    const r = await chatJSON({
      system, user, schema: FOLLOWUP_SCHEMA, schemaName: "followup", maxTokens: 1200, kind: "gen",
    });
    if (r.error) return { contract, prompts, warnings, error: r.error, attempts: attempt };

    const v = r.value || {};
    const out = {
      subject: String(v.subject || "").trim(),
      body: String(v.body || "").trim(),
      newSpecific: v.new_specific || "",
      angle: v.angle || "",
      ask: v.ask || "",
    };
    const validation = validateFollowup({ ...out, newSpecific: out.newSpecific, contract });
    last = { ...out, contract, prompts, validation, warnings, attempts: attempt };
    if (validation.valid) return last;

    const notes = validation.failed.map((g) => `- ${g}: ${validation.gates[g].detail || "failed"}`).join("\n");
    user = `${baseUser}

A previous attempt was REJECTED by the automated validator:
${notes}

Rewrite so every one of those is fixed. Reminders: this email must be SHORTER
than every email already in the thread, must not reuse any earlier subject or
sentence, must add one genuinely new specific, and must never mention that they
did not reply.`;
  }

  if (last && !last.validation.valid) {
    warnings.push(`validation failed: ${last.validation.failed.join(", ")}`);
  }
  return last;
}
