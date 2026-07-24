// Is this string actually a person's name?
//
// The Apollo list contains rows like "Placement Ssce", "Training Cell" and
// "Tpo Shegaon" in the person field — these are shared mailboxes that Apollo
// title-cased into something that looks like a name. EMAIL_GENERATION_CONTEXT.md
// §2 is explicit: "No name means no email. Do not write 'Dear Sir/Madam'."
// Writing "Dear Placement Ssce," is the same failure wearing a hat, and it is
// worse than not sending, because it proves the email was automated.
//
// Used by derive()'s Tier 0 gate, so a non-person contact blocks the send.

// Words that mean this is a function, not a human.
const ROLE_WORDS = [
  "placement", "placements", "training", "cell", "office", "officer", "admin",
  "admission", "admissions", "info", "information", "contact", "enquiry", "enquiries",
  "relations", "corporate", "department", "dept", "institute", "institutes",
  "college", "university", "campus", "career", "careers", "recruitment", "hr",
  "support", "help", "team", "group", "centre", "center", "tpo", "tnp",
];

// Honorifics that are not the name itself.
const TITLES = ["dr", "prof", "mr", "ms", "mrs", "shri", "smt", "er", "capt"];

const words = (s) =>
  String(s || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/**
 * @param {string} name
 * @returns {string} "" when the name looks like a real person, else the reason
 */
export function nameProblem(name) {
  const raw = String(name || "").trim();
  if (!raw) return "blank";

  const parts = words(raw).filter((w) => !TITLES.includes(w.toLowerCase().replace(/\.$/, "")));
  if (parts.length === 0) return "only an honorific";

  const lower = parts.map((w) => w.toLowerCase().replace(/[^a-z]/g, ""));

  // Any role word at all makes it a mailbox, not a person: a real person is not
  // called "Training", and "Placement Ssce" is placement@ with a coat of paint.
  const roleHit = lower.find((w) => ROLE_WORDS.includes(w));
  if (roleHit) return `role word "${roleHit}"`;

  // A single token is not enough to address someone properly.
  if (parts.length < 2) return "single word, no surname";

  // "Tpo Shegaon", "Srkr Relations" — an all-caps-ish acronym token.
  if (parts.some((w) => /^[A-Z]{2,}$/.test(w) && w.length <= 5)) return "acronym, not a name";

  // Digits or symbols never belong in a name.
  if (/[0-9@_/]/.test(raw)) return "contains digits or symbols";

  return "";
}

/** True when the string looks like a real person's name. */
export function isPersonName(name) {
  return nameProblem(name) === "";
}

/** Best-effort salutation name ("Dr. Sanjay Tambi" -> "Sanjay Tambi"). */
export function displayName(name) {
  const parts = words(name).filter((w) => !TITLES.includes(w.toLowerCase().replace(/\.$/, "")));
  return parts.join(" ") || String(name || "").trim();
}
