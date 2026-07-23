// radius_block — EMAIL_GENERATION_CONTEXT.md §7. Static product/proof/offer
// content, one version per segment_template. This is the ONLY place the email
// gets to say anything about us; research_facts says everything about them.
//
// ─────────────────────────────────────────────────────────────────────────────
// READ THE HONESTY NOTE IN §7 BEFORE ADDING ANYTHING HERE.
//
// Every sentence below is a claim you will make to a stranger who can check it.
// There are deliberately NO STATISTICS in the value props. We do not yet have a
// measured before/after ATS pass rate on real Indian student CVs, so quoting one
// would be fabrication — the exact failure the two-call pipeline exists to stop.
// The `no_orphan_numbers` validation gate will also reject any number that is
// not traceable to the input contract or to this file.
//
// When you have the measured stat: put it in PROOF.ats_uplift_stat, add
// "ats_uplift_stat" to PROOF_AVAILABLE in derive.js, and the generator will
// start citing it on the next run. Until then the free audit carries the email.
// ─────────────────────────────────────────────────────────────────────────────

// Who the email is from. These are claims about a real person — set them via
// .env rather than leaving a placeholder in a live send.
export const SIGNATURE = {
  name: process.env.OUTREACH_SENDER_NAME || "",
  credential: process.env.OUTREACH_SENDER_CREDENTIAL || "",
  why: process.env.OUTREACH_SENDER_WHY || "",
};

const PRODUCT_ONE_LINER =
  "RadiusAI turns a student's raw details into a recruiter-ready, ATS-parsable CV in minutes.";

// Keyed by pain_hypothesis. No numbers — see the note above.
const VALUE_PROPS = {
  ats_rejection:
    "A large share of student CVs are rejected by applicant tracking systems for formatting and parsing reasons before any recruiter reads them, which has nothing to do with the student's ability.",
  staff_bandwidth:
    "Reviewing CVs one by one across a full graduating cohort is the part of placement work that does not scale, and it lands on a team of a few people.",
  unreported_cohort:
    "The students who never get a CV review are usually the ones who most need it, and they are also the ones missing from the placement numbers.",
  tier2_recruiter_access:
    "A well-formed CV travels further in off-campus applications, where students are competing without the placement cell standing behind them.",
  accreditation_reporting:
    "Placement outcomes have to be evidenced for NAAC and NIRF submissions, and that reporting is only as good as the underlying student records.",
};

// Keyed by proof_to_cite. Only claims that are true TODAY may live here.
const PROOF = {
  free_audit_only:
    "I would rather show you than tell you, so the audit below is free and there is nothing to sign.",
  // ats_uplift_stat: fill in ONLY with a measured before/after figure.
  // es_london_pilot: real, but does not travel to an Indian TPO. Left out on purpose.
  // dream2rank: fill in when there is something specific to say.
};

// Keyed by offer_variant. Concrete and small enough to say yes to.
const OFFER = {
  free_ats_audit_50:
    "Send me 50 CVs from your most recent batch and I will return a named report showing which ones fail ATS parsing and why. No cost, no commitment.",
  pilot_one_department:
    "We could run this with a single department for one placement cycle before you decide anything wider.",
  group_licence_call:
    "Worth a short call about how this would work across your campuses under one licence.",
};

const CONSTRAINTS = {
  word_cap: "110 to 140 words in the body.",
  forbidden:
    'No em-dashes. No exclamation marks. No "revolutionise", "cutting-edge", "leverage", "in today\'s competitive landscape", "game-changer".',
  pii: "Student CVs shared for an audit are used only for that audit and deleted afterwards. Say so if the audit is mentioned.",
};

// Per-segment framing. The value props, proof and offer maps are shared because
// the pain and the offer are what vary, not the product. What changes per
// segment is who you are writing to and how much institutional weight to assume.
const SEGMENT_FRAMING = {
  group: {
    audience:
      "a placement lead responsible for several campuses at once, who thinks in terms of rollout and consistency rather than individual students",
    posture:
      "Acknowledge the multi-campus scale directly. One decision here covers many campuses, so keep the ask at the level of a conversation, not a trial.",
  },
  elite: {
    audience:
      "a placement head at a highly selective institution whose students already attract strong recruiters",
    posture:
      "Do not imply their placement outcomes are weak, because they are not. The angle is that strong students still lose interviews to CV formatting, which is a mechanical problem rather than a talent one.",
  },
  private_uni: {
    audience:
      "a training and placement head at a private university who owns the placement number and is measured on it",
    posture:
      "They have budget and can decide. Be concrete about what they get and how little it costs them to find out.",
  },
  college: {
    audience:
      "a training and placement officer at a college, often running placements with a very small team",
    posture:
      "Assume limited time and no budget authority. The offer has to be something they can accept without asking anyone.",
  },
  non_engineering: {
    audience:
      "a placement officer at a pharmacy, management, arts or design institution, where recruiters and CV conventions differ from engineering",
    posture:
      "Do not use engineering placement language or assume campus hiring drives. Speak to their own recruiter landscape.",
  },
};

/**
 * Assemble the radius_block for one segment + pain + proof + offer.
 * @returns {object} the static half of the §4 contract
 */
export function radiusBlock({ segment_template, pain_hypothesis, proof_to_cite, offer_variant }) {
  const framing = SEGMENT_FRAMING[segment_template] || SEGMENT_FRAMING.college;
  return {
    product_one_liner: PRODUCT_ONE_LINER,
    audience: framing.audience,
    posture: framing.posture,
    value_prop: VALUE_PROPS[pain_hypothesis] || VALUE_PROPS.ats_rejection,
    proof: PROOF[proof_to_cite] || PROOF.free_audit_only,
    offer: OFFER[offer_variant] || OFFER.free_ats_audit_50,
    signature: SIGNATURE,
    constraints: CONSTRAINTS,
  };
}

/** Every number we are allowed to write, sourced from this file rather than invented. */
export function radiusBlockNumbers(block) {
  const text = [block?.offer, block?.proof, block?.value_prop, block?.product_one_liner]
    .filter(Boolean)
    .join(" ");
  return (text.match(/\d+(?:\.\d+)?/g) || []).map(String);
}

/** Warn loudly rather than send an email signed by nobody. */
export function signatureReady() {
  return Boolean(SIGNATURE.name && SIGNATURE.name.trim());
}
