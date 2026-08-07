// /generate-email — RESEARCH_API_FEATURE.md step 3. LLM call #2.
//
// The generator sees a CONTRACT, never the research blob: only the facts that
// cleared min_confidence, the (at most three) top_hooks, and the intent. This is
// the same wall the institution pipeline puts between extract() and generate() —
// raw prose in, generic email out — and it is what makes "no invented promotions"
// enforceable rather than merely requested.
//
// Every rule the spec states as a prompt instruction is ALSO a code gate below,
// because a prompt is a request and a gate is a rule. The one that matters most
// is no_orphan_numbers: it is the last thing standing between a hallucinated
// "ranked 3rd in India" and the person whose job that ranking is.

import { chatJSON, aiProvider } from "./llm.js";
import { senderBlock, signature, signatureProblem } from "./sender.js";
import { CITATION_FLOOR } from "./researchPerson.js";

// LOCKED 2026-08-03 — the configuration that produced the approved email
// (email_testing id 85): 180-250 words with a gated floor, formal register,
// product URL required, human-verified facts preferred. Bump this version if any
// of those change, so a stored run can be traced back to the prompt that made it.
export const PROMPT_VERSION = "person-v3-2026-08-locked";

const DEFAULT_MAX_WORDS = 250;
// A ceiling alone does not lengthen anything: against a 150-word cap the model
// settled around 115 every time, because "stay under N" is satisfied by any short
// answer. Length needs a floor, a target range, and a gate — otherwise it is just
// another sentence in a prompt.
const DEFAULT_MIN_WORDS = 180;
const TONES = ["formal", "peer", "warm"];

// The spec's rule 5 is "no filler openers", and the expensive part of enforcing it
// is that filler is a family, not a phrase. Every entry below was produced by an
// actual generation against this prompt: the model reliably reaches for "I am
// reaching out to..." and boilerplate praise ("commitment to excellence") the
// moment it is asked to be polite, and both announce a mail merge as loudly as
// "I hope this email finds you well" does.
export const BANNED = [
  "i hope this email finds you well",
  "i hope this finds you well",
  "i hope you are doing well",
  "i hope you are well",
  "i hope this message finds you",
  "i came across your profile",
  "i came across your institution",
  "i am reaching out",
  "i'm reaching out",
  "wanted to reach out",
  "reaching out to you",
  "reaching out to discuss",
  "commitment to excellence",
  "dedication to excellence",
  "is evident through",
  "i trust this email",
  "allow me to introduce",
  "revolutionise", "revolutionize", "cutting-edge", "game-changer", "game changer",
  "in today's competitive landscape",
];

// Some filler is a shape rather than a string: banning "commitment to excellence"
// literally just moves the model to "commitment to academic excellence", which is
// the same empty compliment with a word wedged in. These catch the family.
export const BANNED_PATTERNS = [
  // {0,4}, not {0,2}: a real run produced "commitment to academic and research
  // excellence", where three words sit between "to" and "excellence" and the
  // tighter quantifier let it straight through.
  { re: /\b(commitment|dedication|devotion)\s+to\s+(\w+\s+){0,4}excellence\b/i, label: "generic praise (commitment to excellence)" },
  { re: /\b(impressive|remarkable|outstanding)\s+(achievements|accomplishments|track record)\b/i, label: "generic praise (impressive achievements)" },
  { re: /\bi\s+(am|'m)\s+(writing|reaching)\s+to\s+you\b/i, label: "filler opener (I am writing to you)" },
  { re: /\bas\s+you\s+may\s+(know|be\s+aware)\b/i, label: "filler (as you may know)" },
  // Connective filler from real output: each joins two clauses while adding
  // nothing, and together they are what makes a correct email read flat.
  { re: /\bis\s+(indeed\s+)?(commendable|praiseworthy|noteworthy|laudable)\b/i, label: "empty praise (is commendable)" },
  { re: /\baligns?\s+(perfectly|well|closely|seamlessly)\s+with\b/i, label: "filler connective (aligns perfectly with)" },
  { re: /\bresonat(es?|ing)\s+(well|strongly|deeply)\s+with\b/i, label: "filler connective (resonates well with)" },
  { re: /\bplays?\s+a\s+(vital|key|crucial|pivotal)\s+role\b/i, label: "cliche (plays a vital role)" },
  { re: /\bi\s+would\s+be\s+(pleased|delighted|happy|glad)\s+to\b/i, label: "throat-clearing (I would be delighted to)" },
];

// Enterprise/procurement language. The product is B2C — students are the
// customer and the institution buys nothing — so this vocabulary is not a style
// preference, it is factually the wrong pitch. "Partner" is deliberately absent:
// radiusai.online's own CTA is "Partner With Us".
export const B2B_LANGUAGE = [
  /\blicen[cs]e[sd]?\b/i, /\bprocurement\b/i, /\broll[- ]?out\b/i,
  // "pilot" was banned here as procurement vocabulary. It has to come out: the
  // one sanctioned proof point is the European School of Economics PILOT, so the
  // ban would reject the only evidence the email is allowed to cite.
  /\bdeploy(ment|ing|ed)?\b/i, /\bROI\b/, /\breturn on investment\b/i,
  /\benterprise\b/i, /\bvendor\b/i, /\bSLA\b/, /\bprocure\b/i,
  /\bsolution for your (institution|university|college)\b/i,
  /\binstitutional efficiency\b/i, /\bcost[- ]effective for your\b/i,
];

// Enterprise vocabulary is banned so we do not PITCH procurement — but the whole
// free message is "there is none of that", and the product block's own sanctioned
// lines say "with no procurement to navigate" and "No vendor, no budget, no
// rollout". A flat word ban rejects the copy we told the model to use. So a hit is
// only a hit when it is not negated.
const NEGATED_BEFORE = /\b(no|not|without|zero|never|free from|free of)\b(\s+\S+){0,2}\s*$/i;

export function enterpriseHits(text, patterns) {
  const hits = [];
  for (const re of patterns) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of String(text).matchAll(g)) {
      const before = String(text).slice(Math.max(0, m.index - 40), m.index);
      if (NEGATED_BEFORE.test(before)) continue;   // "no procurement", "without a vendor"
      hits.push(String(re).slice(1, -2));
      break;
    }
  }
  return hits;
}

// Superiority and unprovable claims. Separate from BANNED because these are not a
// style problem: they are assertions we cannot back, and a pilot at one school
// licenses none of them. Always checked, proof or no proof.
export const SUPERIORITY_CLAIMS = [
  { re: /\bonly (company|platform|tool|product)\b/i, label: "superiority (only company)" },
  { re: /#\s?1\b/, label: "superiority (#1)" },
  { re: /\bnumber one\b/i, label: "superiority (number one)" },
  { re: /\bbest[- ]in[- ]class\b/i, label: "superiority (best-in-class)" },
  { re: /\bthe best\b/i, label: "superiority (the best)" },
  { re: /\bproven\b/i, label: "unprovable (proven)" },
  { re: /\bguarantee(s|d|ing)?\b/i, label: "unprovable (guarantee)" },
  { re: /\bwe improve your placements\b/i, label: "unprovable (we improve your placements)" },
  { re: /\bindustry[- ]leading\b/i, label: "superiority (industry-leading)" },
];

// Things a STUDENT owns. The recipient is a placement officer, so "your CV" or
// "your job hunt" addressed to them is simply the wrong person — the product is
// B2C but the reader is not the consumer. Body copy got this right via rule 10b
// from the start; subjects did not, and 5 of 10 in a real batch shipped with it.
// The {0,2} gap matters: the first version of this demanded "your" immediately
// before the noun, so "Secure Your Dream Job with RadiusAI" walked straight
// through. The negative lookahead matters just as much in the other direction —
// "your student CVs" and "your students' applications" are the CORRECT phrasing
// and must not be flagged.
const STUDENT_OWNED =
  /\byour\s+(?!students?\b)(?:\w+\s+){0,2}(cvs?|resumes?|jobs?|career|careers|future|applications?|potential|interviews?)\b/i;

const EMAIL_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Max 8 words. Specific. No colons, no 'Re:', no clickbait." },
    body: { type: "string", description: "Plain text. Greeting, body, sign-off." },
    hooks_used: {
      type: "array",
      items: { type: "string" },
      description: "Copy VERBATIM the top_hooks you referenced. Empty if none.",
    },
    facts_cited: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fact: { type: "string", description: "Copied verbatim from allowed_facts." },
          source_url: { type: ["string", "null"], description: "That fact's source_url." },
        },
        required: ["fact", "source_url"],
        additionalProperties: false,
      },
      description: "Every allowed fact you referenced in the body.",
    },
  },
  required: ["subject", "body", "hooks_used", "facts_cited"],
  additionalProperties: false,
};

// TONE_GUIDE used to live here. Voice is now chosen by role.tone_register
// (REGISTER_GUIDE below) rather than by the research-derived `tone` field, because
// the register that suits a reader is a fact about their job, not about how their
// institution writes. `tone` is still carried on the contract for the record.

// The two voices. Which one runs is a property of the ROLE (role.tone_register),
// not of the institution: a faculty member holding the placement brief and a
// placement manager at the same college are not addressed the same way.
const REGISTER_GUIDE = {
  academic: `Formal and precise. Address by title and surname, Dr. or Prof. where
applicable. No contractions. Measured and respectful. State the free and analytics
facts plainly. Use "it has never been easier", never "no excuse".`,
  operational: `Direct and confident. Short, punchy sentences. Contractions are
fine. Blunt clarity is wanted: "no reason not to", "it costs you nothing", "it has
never been easier", and you may use "no excuse for any of your students to go in
with a weak CV". Still professional. No hype words, no exclamation marks.`,
};

function systemPrompt({ mode, tone, maxWords, minWords, thin, register }) {
  const frame = `FRAME (most important)
The subject line and the opening sentence are written from the UNIVERSITY'S point
of view, not the student's. The reader is not applying for jobs. Never make a
student the subject of the subject line or the opening. Point every student
benefit at the officer.

MUST STATE (from product.must_state)
- FREE is mandatory and appears in the SUBJECT, the OPENING, and the CLOSING. It
  is the spine of the email. Use the register-appropriate line from spine_free.
- OPENING FUSION: the opening sentence still leads on the institution's strongest
  specific hook (from top_hooks), and the free fact lands in the same breath or
  the very next sentence. Do NOT open every email with an identical generic line
  about being free; open on THEM, then hit free immediately. For thin-coverage
  schools with no strong hook, leading on free is fine.
- BODY: lead the body on the campaign's chosen_angles (one, at most two). Express
  the angle through this institution's own facts, using its headline as the force
  and its substance as the provable backing. Do not list every angle; carry only
  the chosen one(s).
- Do NOT state revenue in the initial email; that is a follow-up pillar.

CLAIMS DISCIPLINE
Provable only. Say "professional, ATS-ready applications", "placement-ready",
"free", "live cohort visibility", or cite the European School of Economics pilot
if there is room. NEVER "only company", "#1", "best", "proven", "we improve your
placements", "guarantee", or any number not in allowed_facts. "Free" needs no
proof; lean on it.

TONE
${REGISTER_GUIDE[register] || REGISTER_GUIDE.academic}`;

  const shared = `${frame}

RULES
1. LENGTH: ${minWords} to ${maxWords} words in the body, and count them. Earn the
   length with specifics, never restatement.
2. Cite ONLY facts in allowed_facts. Introduce no number, ranking, date, employer,
   award or shared history that is not there.
3. Use at most the hooks in top_hooks, verbatim in meaning. Never invent a hook.
   Facts flagged verified_by_human were supplied on purpose; prefer them and cite
   at least one when there is room.
4. No filler openers, no announcing yourself. Banned: "I hope this email finds you
   well", "I am reaching out", "I wanted to reach out", "allow me to introduce".
   The opening leads on the institution's hook fused with the FREE fact instead.
5. No generic praise. "Commitment to excellence" and "impressive achievements" say
   nothing. If you compliment them, name the specific fact.
6. One clear ask, at the end, taken from campaign.cta. Never two questions.
7. No em-dashes. No corporate cliche. No exclamation marks.
8. SUBJECT: max 8 words, specific, no colon, no "Re:". It leads on the
   university's win, ideally the free/zero-cost fact, from the university's point
   of view. It must NOT contain the recipient's name and must NOT address them as
   the applicant ("your CV", "your job hunt"). If avoid_subjects is present, be
   clearly different from all of them.
9. hooks_used must copy the top_hooks you referenced; facts_cited must copy the
   allowed_facts you referenced. Both are checked against your body.
10. LINK: include product.url exactly once, verbatim, on its own line beside the
   ask. Do not shorten, wrap or add parameters.
11. SIGN OFF with exactly the two lines in sender.sign_off_exactly, name then
   title. NEVER a bracketed placeholder.
12. Describe the product using ONLY the capabilities and must_state it lists. If
   proof_available is NONE, invent nothing.
13. STILL BANNED even though you are writing to the institution: procurement and
   enterprise language (licence, rollout, deployment, ROI, vendor, "solution for
   your institution", SLA). You are not selling the officer a paid product; they
   get the analytics and the outcome free because their students use it. Say the
   concrete free benefit, never enterprise waffle.
14. Carry campaign.theme and campaign.pain_framing. Draw on
   campaign.talking_points. Do not paste campaign_line into the body.`;

  if (thin) {
    return `You write one short cold outreach email TO the person in recipient. They are a
PLACEMENT OFFICER at a university. Research on this institution came back THIN:
there are few or no verified specifics about them.

Write an honest, short email. Do not fake familiarity and do not imply you have
read their work or share a connection. With no strong hook to open on, lead on the
FREE fact: it costs the university nothing and every student starts free. That is
true of every institution, so it is not fake personalisation, and it is the one
thing worth saying when you know little else.

${shared}`;
  }

  if (mode === "on_behalf") {
    return `You write one email SENT BY the person described in sender, TO the person in
recipient, who is a PLACEMENT OFFICER at a university. You write in the sender's
voice, first person.

Open on the institution's strongest hook, not on the sender's credentials.
Establish in one line who the sender is and why they are writing to THIS
institution rather than any other.

${shared}`;
  }

  return `You write one cold outreach email TO the person in recipient. They are a PLACEMENT
OFFICER at a university. They are the reader and the decision-maker, and they act
on what THEY get.

${shared}`;
}

/**
 * The contract handed to the model: only what cleared the floor. Exported so a
 * caller can inspect exactly what the email was allowed to know.
 */
export function buildEmailContract({ research, mode, emailIntent, senderContext, minConfidence, tone, maxWords, minWords, product, campaign, recentSubjects, role }) {
  const allowed = (research?.provenance || [])
    .filter((p) => p?.fact && Number(p.confidence) >= minConfidence)
    .map((p) => ({ fact: p.fact, source_url: p.source_url || null }));

  const syn = research?.synthesis || {};
  const contract = {
    mode,
    min_words: minWords,
    email_intent: emailIntent || "",
    recipient: mode === "on_behalf" ? compactTarget(research) : compactPerson(research),
    organisation: compactOrg(research),
    top_hooks: (syn.top_hooks || []).slice(0, 3),
    trigger_event: syn.trigger_event || "",
    shared_context: syn.shared_context || "",
    suggested_subject_angle: syn.suggested_subject_angle || "",
    tone,
    max_words: maxWords,
    allowed_facts: allowed,
    coverage: research?.meta?.coverage || "thin",
  };
  // Who is writing. Present in every mode — without it the model signs off with a
  // bracketed placeholder, which is the single clearest tell that nobody read the
  // email before it was sent.
  contract.sender = senderBlock(senderContext);
  if (mode === "on_behalf") {
    contract.sender = {
      ...contract.sender,
      description: senderContext || "",
      name: research?.person?.full_name || "",
      title: research?.person?.current_title || "",
      org: research?.person?.current_org || research?.person?.university || "",
    };
  }

  // What WE are, and the org-level campaign this person's email sits under. Both
  // optional: /generate-email is still usable with research alone.
  if (research?.university?.placement) contract.placement = research.university.placement;
  // What this ROLE is trying to achieve, researched once and cached. Replaces the
  // per-person research that used to return almost nothing for these contacts.
  if (role) contract.role = role;
  if (product) {
    contract.product = product;
    // Said explicitly rather than left as an empty array to be noticed. An absent
    // proof section is exactly where a model starts improvising one.
    contract.proof_available = (product.proof_points || []).length
      ? product.proof_points
      : "NONE. Claim no statistics, customers or testimonials — there are none to cite.";
  }
  if (campaign) contract.campaign = campaign;

  // Subjects already sent to this institution. The campaign is deliberately
  // shared across everyone there, which makes it very easy for the subject line
  // to be shared too — and a row of identical subjects into one domain is the
  // clearest bulk-blast signal there is. The campaign supplies several
  // subject_angles precisely so each recipient can take a different one.
  if (recentSubjects?.length) contract.avoid_subjects = recentSubjects.slice(0, 10);

  return contract;
}

const drop = (o) => {
  for (const k of Object.keys(o)) if (!o[k]) delete o[k];
  return o;
};

const compactPerson = (r) => drop({
  full_name: r?.person?.full_name || "",
  current_title: r?.person?.current_title || "",
  current_org: r?.person?.current_org || "",
  university: r?.person?.university || "",
  location: r?.person?.location || "",
});

const compactTarget = (r) => drop({
  full_name: r?.target?.name || "",
  role: r?.target?.role || "",
  org: r?.target?.org || "",
});

const compactOrg = (r) => drop({
  name: r?.university?.name || "",
  relevant_department: r?.university?.relevant_department || "",
  location: r?.university?.location || "",
});

// ── validation ──────────────────────────────────────────────────────────────

export const norm = (s) => String(s ?? "").toLowerCase();
const numbersIn = (s) => (String(s ?? "").match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, ""));

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "your", "their", "have", "been", "will", "they"]);
function contentWords(s) {
  return new Set(
    norm(s).replace(/[^a-z0-9\s'+-]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w))
  );
}
export function overlap(a, b) {
  const wa = contentWords(a);
  const wb = contentWords(b);
  let hits = 0;
  for (const w of wa) if (wb.has(w)) hits += 1;
  return hits;
}

/**
 * Every gate. Fail closed — a rejected draft costs one retry, a fabricated one
 * costs the relationship.
 *
 * @returns {{valid: boolean, gates: object, failed: string[]}}
 */
export function validatePersonEmail({ subject, body, hooksUsed = [], factsCited = [], contract, thin = false }) {
  const gates = {};
  const add = (name, pass, detail) => { gates[name] = { pass: Boolean(pass), detail: detail || null }; };

  const text = String(body || "");
  const words = text.trim().split(/\s+/).filter(Boolean);
  const allowedFacts = contract?.allowed_facts || [];
  const topHooks = contract?.top_hooks || [];

  // 0b. product_link_present — a prompt is a request; this is the rule. Compared
  //     with protocol, "www." and trailing slash stripped, so any reasonable
  //     rendering counts and only a genuinely missing link fails.
  const productUrl = contract?.product?.url;
  if (productUrl) {
    const bare = (u) => String(u).trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    const hasUrl = bare(text).includes(bare(productUrl));
    // A plain-text email renders "[label](url)" literally, brackets and all. The
    // URL being present is not enough; it has to be bare.
    const wrapped = /\[[^\]\n]*\]\(\s*https?:\/\//i.test(text);
    add("product_link_present", hasUrl && !wrapped,
      !hasUrl ? `body must contain ${productUrl}`
        : wrapped ? "the link is wrapped in markdown; write the URL bare on its own line"
        : null);
  }

  // 0b2. signature_real — a bracketed placeholder proves the email was generated
  //      and never read. Fail closed: this one is embarrassing in a way a clumsy
  //      sentence is not, and it is trivially checkable in code.
  const sigProblem = signatureProblem(body);
  add("signature_real", !sigProblem, sigProblem);

  // 0c. min_words — skipped on thin coverage, where short and honest is correct
  //     and padding produces exactly the fake-personal email we avoid.
  const minW = Number(contract?.min_words) || 0;
  if (minW && !thin) add("min_words", words.length >= minW, `${words.length}/${minW} words minimum`);

  // 0d. subject_not_personalised — a subject carrying the recipient's own name is
  //     the clearest "you are a row in someone's spreadsheet" signal there is.
  const rName = String(contract?.recipient?.name || "").trim();
  if (rName) {
    const parts = rName.split(/\s+/).filter((w) => w.length > 2);
    const subjNorm = norm(subject);
    const hit = parts.filter((w) => subjNorm.includes(norm(w)));
    add("subject_not_personalised", hit.length < Math.max(1, parts.length),
      hit.length ? `subject contains the recipient's name: ${hit.join(" ")}` : null);
  }

  // 0e. no_roadmap_claims — the product data marks some features as roadmap-only.
  //     Describing one as available is the same failure class as inventing a
  //     statistic: a claim the reader could act on that is not true yet.
  const forbidden = contract?.product?.do_not_cite || [];
  if (forbidden.length) {
    const hits = forbidden.filter((f) => {
      const key = String(f).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 4).slice(0, 4);
      return key.length >= 2 && key.every((w) => norm(text).includes(w));
    });
    add("no_roadmap_claims", hits.length === 0, hits.length ? `roadmap-only feature described as available: ${hits[0]}` : null);
  }

  // 1. max_words — the spec's constraint, enforced rather than suggested.
  add("max_words", words.length <= contract.max_words, `${words.length}/${contract.max_words} words`);

  // 2. no_orphan_numbers — every digit must trace to something we actually know.
  const allowedNumbers = new Set();
  const harvest = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) return v.forEach(harvest);
    if (typeof v === "object") return Object.values(v).forEach(harvest);
    numbersIn(v).forEach((n) => allowedNumbers.add(n));
  };
  harvest(allowedFacts);
  harvest(topHooks);
  harvest(contract?.recipient);
  harvest(contract?.organisation);
  harvest(contract?.trigger_event);
  harvest(contract?.shared_context);
  harvest(contract?.sender);
  harvest(contract?.email_intent);
  harvest(contract?.product);
  harvest(contract?.campaign);
  const orphans = [...new Set(numbersIn(text))].filter((n) => !allowedNumbers.has(n));
  add("no_orphan_numbers", orphans.length === 0,
    orphans.length ? `untraceable number(s): ${orphans.join(", ")}` : null);

  // 3. banned_phrases — the filler openers the spec names, plus em-dashes, plus
  //    enterprise vocabulary (the product is B2C; students are the customer).
  const hits = BANNED.filter((p) => norm(text).includes(p));
  for (const h of enterpriseHits(text, B2B_LANGUAGE)) hits.push(`B2B language: ${h}`);
  for (const { re, label } of BANNED_PATTERNS) if (re.test(text)) hits.push(label);
  for (const { re, label } of SUPERIORITY_CLAIMS) if (re.test(text)) hits.push(label);
  if (text.includes("—") || text.includes("–")) hits.push("em-dash");
  add("banned_phrases", hits.length === 0, hits.length ? hits.join(", ") : null);

  // 3b. states_free — FREE is the whole thesis, and it kept slipping out of
  //     emails that were otherwise fine. It must appear in the SUBJECT and the
  //     BODY, not just somewhere in the text, because a body-only mention loses
  //     the one thing that makes the email worth opening. Deliberately keyword
  //     based rather than semantic: this gate is here to catch omission, not to
  //     grade phrasing. Not applied to follow-ups — validateFollowup is separate.
  const saysFree = (t) => /\bfree\b|\bno cost\b|\bat no cost\b|\bzero cost\b|\bcosts? (you|your university|the university) nothing\b/i.test(String(t || ""));
  const freeInSubject = saysFree(subject);
  const freeInBody = saysFree(body);
  add("states_free", freeInSubject && freeInBody,
    freeInSubject && freeInBody ? null
      : !freeInSubject && !freeInBody ? "the free/zero-cost message is missing from both subject and body"
      : !freeInSubject ? "subject does not state that it is free"
      : "body does not state that it is free");

  // 4. hooks_within_top3 — a hook the model made up is the failure mode this
  //    whole API exists to prevent, so an unrecognised hook is a hard fail.
  const strayHooks = hooksUsed.filter((h) => !topHooks.some((t) => overlap(t, h) >= 2 || norm(t) === norm(h)));
  add("hooks_within_top3", hooksUsed.length <= 3 && strayHooks.length === 0,
    strayHooks.length ? `not in top_hooks: ${strayHooks.join(" | ").slice(0, 200)}`
      : hooksUsed.length > 3 ? `${hooksUsed.length} hooks used` : null);

  // 5. facts_cited_allowed — cited facts must exist in the contract...
  const strayFacts = factsCited
    .map((f) => (typeof f === "string" ? f : f?.fact))
    .filter(Boolean)
    .filter((f) => !allowedFacts.some((a) => norm(a.fact) === norm(f) || overlap(a.fact, f) >= 3));
  add("facts_cited_allowed", strayFacts.length === 0,
    strayFacts.length ? `not in allowed_facts: ${strayFacts.join(" | ").slice(0, 200)}` : null);

  // 6. ...and must actually appear in the body, or the citation is decorative.
  const notInBody = factsCited
    .map((f) => (typeof f === "string" ? f : f?.fact))
    .filter(Boolean)
    .filter((f) => overlap(f, text) < 2);
  add("facts_cited_present", notInBody.length === 0,
    notInBody.length ? `listed but absent from body: ${notInBody.length}` : null);

  // 7. opens_on_trigger — only when there is one. The greeting is not the opening.
  if (contract?.trigger_event && !thin) {
    const afterGreeting = text.replace(/^\s*(dear|hello|hi|good\s+\w+)\b[^\n,]*,?\s*/i, "");
    const opening = afterGreeting.split(/(?<=[.!?])\s/).slice(0, 2).join(" ");
    add("opens_on_trigger", overlap(contract.trigger_event, opening) >= 2,
      `${overlap(contract.trigger_event, opening)} overlapping word(s) with trigger_event`);
  }

  // 8. thin_is_honest — a thin-coverage email must not claim specifics it does
  //    not have. If research found nothing, citing something is fabrication.
  if (thin) {
    add("thin_is_honest", factsCited.length === 0 || allowedFacts.length > 0,
      factsCited.length ? `cited ${factsCited.length} fact(s) with no allowed facts` : null);
  }

  // 9. correct_addressee — the reader is the officer, not the student.
  const addresseeHits = [];
  if (STUDENT_OWNED.test(String(subject || ""))) addresseeHits.push(`subject: "${String(subject).match(STUDENT_OWNED)[0]}"`);
  if (STUDENT_OWNED.test(text)) addresseeHits.push(`body: "${text.match(STUDENT_OWNED)[0]}"`);
  add("correct_addressee", addresseeHits.length === 0,
    addresseeHits.length ? `addresses the recipient as if they were the student — ${addresseeHits.join(", ")}` : null);

  // 10. subject_not_reused — colleagues at one institution comparing notes should
  //    not find the same subject line twice. Shares the campaign, not the envelope.
  const subj = String(subject || "");
  const reused = (contract?.avoid_subjects || []).filter(
    (s) => norm(s) === norm(subj) || overlap(s, subj) >= 3
  );
  add("subject_not_reused", reused.length === 0,
    reused.length ? `too close to a subject already used here: "${reused[0]}"` : null);

  // 11. subject_present — and shaped as rule 8 asks. "Demo: Enhance Placements"
  //     reads as a template slot, which is the look we are avoiding.
  const subjWords = String(subject || "").trim().split(/\s+/).filter(Boolean).length;
  const subjProblem = !String(subject || "").trim() ? "empty subject"
    : subjWords > 12 ? `${subjWords} words`
    : /:/.test(subj) ? "contains a colon"
    : /^re:/i.test(String(subject).trim()) ? 'starts with "Re:"'
    : null;
  add("subject_present", subjProblem === null, subjProblem);

  const failed = Object.entries(gates).filter(([, g]) => !g.pass).map(([n]) => n);
  return { valid: failed.length === 0, gates, failed };
}

// ── generation ──────────────────────────────────────────────────────────────

/**
 * Generate one email from a research output.
 *
 * @param {object} a
 * @param {object} a.research      full /research output
 * @param {"to_person"|"on_behalf"} [a.mode]
 * @param {string} [a.emailIntent]
 * @param {string} [a.senderContext]
 * @param {object} [a.constraints] { max_words, tone_override, min_confidence }
 * @returns {Promise<{subject?, body?, hooksUsed?, factsCited?, warnings?, validation?, contract, prompts, error?}>}
 */
export async function generatePersonEmail({
  research,
  mode = "to_person",
  emailIntent = "",
  senderContext = "",
  constraints = {},
  product = null,
  campaign = null,
  recentSubjects = [],
  role = null,
  attempts = 2,
}) {
  const maxWords = Number.isFinite(Number(constraints.max_words)) ? Number(constraints.max_words) : DEFAULT_MAX_WORDS;
  const minWords = Number.isFinite(Number(constraints.min_words))
    ? Number(constraints.min_words)
    : Math.min(DEFAULT_MIN_WORDS, Math.round(maxWords * 0.72));
  const minConfidence = Number.isFinite(Number(constraints.min_confidence))
    ? Number(constraints.min_confidence)
    : CITATION_FLOOR;
  const override = constraints.tone_override;
  const tone = TONES.includes(override) ? override : (research?.synthesis?.recommended_tone || "formal");

  const contract = buildEmailContract({
    research, mode, emailIntent, senderContext, minConfidence, tone, maxWords, minWords, product, campaign, recentSubjects, role,
  });

  const warnings = [];
  // Thin is decided by the research meta AND by what actually survived the floor:
  // a caller raising min_confidence can thin out a "high" coverage research row,
  // and the email must degrade with it rather than cite what it no longer has.
  const thin = contract.coverage === "thin" || contract.allowed_facts.length === 0 || contract.top_hooks.length < 2;
  if (thin) {
    warnings.push(
      contract.coverage === "thin"
        ? "thin coverage, email is generic"
        : `no facts cleared min_confidence ${minConfidence}, email is generic`
    );
  }
  if (research?.meta?.search_disabled) {
    warnings.push("no search provider configured, research used only the supplied URLs");
  }

  // Voice comes from the role, defaulting to the lower-risk formal one.
  const register = contract?.role?.tone_register === "operational" ? "operational" : "academic";
  const system = systemPrompt({ mode, tone, maxWords, minWords, thin, register });
  const basePrompt = `INPUT\n${JSON.stringify(contract, null, 2)}`;
  let userPrompt = basePrompt;
  let last = null;

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    const prompts = { system, user: userPrompt, version: PROMPT_VERSION };
    const r = await chatJSON({
      system,
      user: userPrompt,
      schema: EMAIL_SCHEMA,
      schemaName: "outreach_email",
      maxTokens: 1500,
      kind: "gen",
    });
    if (r.error) return { prompts, contract, warnings, error: r.error, attempts: attempt };

    const v = r.value || {};
    if (!v.subject || !v.body) {
      return { prompts, contract, warnings, error: "The model returned an empty email.", attempts: attempt };
    }

    const hooksUsed = (Array.isArray(v.hooks_used) ? v.hooks_used : []).map(String);
    const factsCited = (Array.isArray(v.facts_cited) ? v.facts_cited : [])
      .filter((f) => f && f.fact)
      .map((f) => ({ fact: String(f.fact), source_url: f.source_url || null }));

    const validation = validatePersonEmail({
      subject: v.subject, body: v.body, hooksUsed, factsCited, contract, thin,
    });

    last = {
      prompts, contract, warnings,
      subject: String(v.subject).trim(),
      body: String(v.body).trim(),
      hooksUsed, factsCited, validation,
      attempts: attempt,
    };
    if (validation.valid) return last;

    // Most rejections are near-misses (three words over, one em-dash) that the
    // model fixes when told exactly what failed. The retry is re-validated from
    // scratch — nothing is waved through.
    const notes = validation.failed
      .map((g) => `- ${g}: ${validation.gates[g].detail || "failed"}`)
      .join("\n");
    userPrompt = `${basePrompt}

A previous attempt was REJECTED by the automated validator:
${notes}

Rewrite so every one of those is fixed, keeping what was fine. Reminders: stay
under ${maxWords} words; every number must come from allowed_facts; use only the
given top_hooks; no em-dashes.`;
  }

  if (last && !last.validation.valid) {
    last.warnings = [...warnings, `validation failed: ${last.validation.failed.join(", ")}`];
  }
  return last;
}

export { aiProvider };
