// Research API — sourcing + extraction (RESEARCH_API_FEATURE.md steps 1-2).
//
// Two levels, because that is how the traffic actually looks: ONE organisation is
// researched and reused by every person at it, and a thin person layer on top is
// what makes each email different. Researching NIT Trichy twenty-seven times for
// twenty-seven contacts would be twenty-seven crawls to produce the same
// paragraph, so org research is cached (see personResearchStore.js) and the
// person layer is the only part that reruns per contact.
//
//   searchPerson/searchOrg ──► crawlPages ──► extract (LLM #1) ──► enforceSourcing
//                                                                        │
//                                                    synthesize.js ◄─────┘  (pure code)
//
// The wall this module defends is the same one the institution pipeline defends:
// a fact with no fetched source URL cannot be cited in an email. Here it is
// enforced with three confidence tiers rather than a boolean, because search
// gives us a real middle case:
//
//   fetched page      → the model's confidence stands. We read the page ourselves.
//   search snippet    → capped below the floor. Someone else's index said so; we
//                       did not open it. Good enough to steer synthesis, never
//                       good enough to assert back to the recipient.
//   anything else     → demoted to 0.5. An unsourced fact is an assertion.
//
// LinkedIn is always the snippet case: it serves an auth wall to servers, so the
// linkedin_url on every request is a routing input, never a readable source.

import { chatJSON, aiProvider } from "./llm.js";
import { crawlInstitution, crawlPages, isUnfetchable } from "./researchCrawl.js";
import { multiSearch, searchEnabled } from "./search.js";

// The spec's default min_confidence. Facts at or above this may be cited.
export const CITATION_FLOOR = 0.7;
// Ceiling for a fact we only saw in someone else's search index.
export const SNIPPET_CONFIDENCE_CAP = 0.65;
// Ceiling for a fact whose source_url we never fetched or saw at all.
export const UNSOURCED_CONFIDENCE = 0.5;

const MAX_ORG_PAGES = 6;
const MAX_PERSON_PAGES = 4;

export const ORG_TYPES = [
  "institute_of_national_importance", "public_university", "private_university",
  "deemed_university", "autonomous_college", "affiliated_college", "research_institute",
  "company", "nonprofit", "government", "other",
];

// ── JSON-schema helpers (OpenAI strict mode needs type unions, not nullable) ──
const nstr = (d) => ({ type: ["string", "null"], description: d });
const nint = (d) => ({ type: ["integer", "null"], description: d });
const nenum = (values, d) => ({ type: ["string", "null"], enum: [...values, null], description: d });
const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

// One sourced claim. `fact` is a self-contained sentence because it is what the
// email generator is allowed to quote and what /generate-email echoes back in
// facts_cited — a bare value like "2019" would be uncheckable there.
const FACT = obj({
  fact: { type: "string", description: "One self-contained, verifiable sentence. Not a fragment." },
  source_url: nstr("Copied EXACTLY from a [SOURCE n] url= line. Never invented."),
  confidence: { type: "number", description: "0.0-1.0." },
});

const HOOK = obj({
  text: { type: "string", description: "One specific angle for opening an email, max 25 words." },
  source_url: nstr("Copied EXACTLY from a [SOURCE n] url= line."),
  confidence: { type: "number", description: "0.0-1.0." },
  is_trigger: { type: "boolean", description: "True only for a dated event in the last 12 months that is a reason to write NOW." },
  date: nstr("ISO YYYY-MM-DD when this is a dated event, else null."),
});

const ORG_SCHEMA = obj({
  name: nstr("Official name as written on their own site."),
  location: nstr("City, state/country."),
  type: nenum(ORG_TYPES, ""),
  relevant_department: nstr("The department tied to THIS person. Null if the sources do not identify one."),
  ranking_notes: nstr("Ranking/accreditation stated by a source, e.g. 'NIRF 2024 rank 9 (Engineering)'. Null unless stated."),
  recent_news: { type: "array", items: FACT, description: "Max 5. Dated institutional news. Empty when none is dated and sourced." },
  key_urls: { type: "array", items: { type: "string" }, description: "Only URLs that appeared in the sources." },
  hooks: { type: "array", items: HOOK, description: "Max 5 candidate org-level angles. Code picks the final 3." },
  facts: { type: "array", items: FACT, description: "Every claim above that could be quoted in an email." },
});

const PERSON_SCHEMA = obj({
  full_name: nstr("As written in the sources."),
  current_title: nstr(""),
  current_org: nstr(""),
  university: nstr("Where they studied or where they now work, per the sources."),
  program_or_degree: nstr("e.g. 'PhD, Computer Science'."),
  grad_year: nstr("Year as a string, or null."),
  location: nstr(""),
  linkedin_headline: nstr("Only if a source actually shows it."),
  linkedin_about: nstr("Only if a source actually shows it. Max 600 chars."),
  recent_activity: { type: "array", items: FACT, description: "Max 5. Job change, promotion, post, talk, paper." },
  skills_interests: { type: "array", items: { type: "string" }, description: "Max 8, only if sourced." },
  notable_items: { type: "array", items: FACT, description: "Max 5. Awards, publications, projects." },
  hooks: { type: "array", items: HOOK, description: "Max 5 candidate person-level angles. Code picks the final 3." },
  facts: { type: "array", items: FACT, description: "Every claim above that could be quoted in an email." },
});

const SYSTEM_BASE = `You extract structured, SOURCED facts from web pages for a cold-email
research API.

RULES
1. Output valid JSON only. No preamble, no markdown fences, no commentary.
2. Never infer, estimate, or answer from your own knowledge. If the sources do not
   state it, output null or an empty array. A null is a correct answer here.
3. Every fact and every hook must carry a source_url copied EXACTLY from one of the
   [SOURCE n] url= lines. A fact whose source_url is not one of those URLs is
   discarded by code, so an unsourced fact is a wasted one. Never invent a URL.
4. Sources marked kind=search_snippet were NOT opened by us. Facts drawn from them
   are capped below the citation floor by code, so prefer a fetched page whenever
   both say the same thing.
5. A hook must be something that would be FALSE of a different person or a
   different institution. "Is a leading institution", "focuses on excellence" and
   "affiliated to X" are true of hundreds and are not hooks.
6. is_trigger is only for a dated event within the last 12 months that gives a
   reason to write NOW. Undated means is_trigger false.
7. Numbers are the highest-risk output. A wrong rank, year or headcount quoted
   back at the person it belongs to destroys the lead. When a number is ambiguous,
   omit it.`;

const ORG_SYSTEM = `${SYSTEM_BASE}
8. You are extracting facts about the TARGET ORGANISATION only. Many of these
   sites belong to a group or trust running several institutions. A sibling's
   ranking, accreditation or award must NEVER be recorded as the target's. If a
   fact could belong to either, omit it.`;

const PERSON_SYSTEM = `${SYSTEM_BASE}
8. You are extracting facts about ONE named person. Common names collide: if a
   source is plainly about a different person with the same name (different field,
   different country, different employer), ignore it entirely rather than blending
   the two. A merged identity is the worst possible output — it produces an email
   that congratulates someone on a stranger's promotion.
9. linkedin_headline and linkedin_about must be null unless a source literally
   shows that text. Do not reconstruct them from the person's title.`;

// ── sourcing enforcement ────────────────────────────────────────────────────

const clampConf = (c) => {
  const n = Number(c);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 1);
};

/**
 * Apply in code what the prompt only requests. Returns the enforcement report so
 * a demotion is explainable later rather than invisible.
 *
 * @param {{facts?: Array, hooks?: Array}} block  mutated in place
 * @param {{fetched: Set<string>, snippet: Set<string>}} urls
 */
export function enforceSourcing(block, urls) {
  const fetched = urls?.fetched instanceof Set ? urls.fetched : new Set(urls?.fetched || []);
  const snippet = urls?.snippet instanceof Set ? urls.snippet : new Set(urls?.snippet || []);
  const report = { demoted: [], snippet_capped: [], kept: 0 };

  const apply = (item, label) => {
    const url = item?.source_url || null;
    let conf = clampConf(item?.confidence);
    if (url && fetched.has(url)) {
      // We opened this page ourselves. The model's confidence stands.
    } else if (url && snippet.has(url)) {
      if (conf > SNIPPET_CONFIDENCE_CAP) {
        conf = SNIPPET_CONFIDENCE_CAP;
        report.snippet_capped.push(label);
      }
      item.snippet_only = true;
    } else {
      if (conf > UNSOURCED_CONFIDENCE) report.demoted.push(label);
      conf = Math.min(conf, UNSOURCED_CONFIDENCE);
      item.unsourced = true;
    }
    item.confidence = conf;
    if (conf >= CITATION_FLOOR) report.kept += 1;
    return item;
  };

  for (const f of block?.facts || []) apply(f, f.fact?.slice(0, 60) || "(fact)");
  for (const h of block?.hooks || []) apply(h, h.text?.slice(0, 60) || "(hook)");
  for (const key of ["recent_news", "recent_activity", "notable_items"]) {
    for (const f of block?.[key] || []) apply(f, `${key}: ${(f.fact || "").slice(0, 50)}`);
  }
  return report;
}

/** Merge crawled documents and un-fetchable search snippets into one citable corpus. */
function buildSourceMaterial(documents, snippets) {
  const parts = documents.map(
    (d, i) => `[SOURCE ${i + 1}] kind=${d.kind} url=${d.url}\n${d.text}`
  );
  snippets.forEach((s, i) => {
    parts.push(
      `[SOURCE ${documents.length + i + 1}] kind=search_snippet url=${s.url}\n` +
        `${s.title || ""}\n${s.snippet || ""}`
    );
  });
  return parts.join("\n\n---\n\n");
}

function urlList(documents, snippets) {
  return [
    ...documents.map((d, i) => `  [SOURCE ${i + 1}] ${d.url}`),
    ...snippets.map((s, i) => `  [SOURCE ${documents.length + i + 1}] ${s.url} (snippet only)`),
  ].join("\n");
}

/**
 * Split search hits into pages worth fetching and snippets we can only quote
 * weakly. Anything behind an auth wall stays a snippet by definition.
 */
function partitionHits(hits, limit) {
  const fetchable = [];
  const snippets = [];
  for (const h of hits) {
    if (isUnfetchable(h.url)) snippets.push(h);
    else if (fetchable.length < limit) fetchable.push(h);
    else snippets.push(h);
  }
  return { fetchable, snippets };
}

// ── org research ────────────────────────────────────────────────────────────

/**
 * Research one organisation. This is the cached, shared half — every person at
 * this university reuses the result.
 *
 * @param {object} a
 * @param {string} a.name          organisation / university name
 * @param {string} [a.url]         known website, if the caller has one
 * @param {string} [a.department]  the department tied to the person, to focus the search
 * @param {string} [a.field]       subject area, used to find department news
 * @returns {Promise<{org?: object, sources?: object, quality?: object, error?: string}>}
 */
export async function researchOrg({ name, url, department, field }) {
  const orgName = String(name || "").trim();
  if (!orgName && !url) return { error: "An organisation name or url is required." };

  const queries = [
    `${orgName} official site`,
    department ? `${orgName} ${department} department` : `${orgName} departments`,
    `${orgName} news ${new Date().getFullYear()}`,
    field ? `${orgName} ${field} research news` : `${orgName} ranking accreditation`,
  ];
  const search = await multiSearch(queries, { perQuery: 4 });
  const { fetchable, snippets } = partitionHits(search.results, MAX_ORG_PAGES);

  // A known website is worth more than any search hit: crawlInstitution() follows
  // the site's own navigation, which is how the about/news/department pages get
  // read rather than guessed at.
  const documents = [];
  if (url) {
    const crawled = await crawlInstitution(url);
    if (crawled.documents) documents.push(...crawled.documents);
  }
  const room = MAX_ORG_PAGES - documents.length;
  if (room > 0 && fetchable.length) {
    const { documents: extra } = await crawlPages(fetchable, { limit: room, kind: "search_result" });
    const have = new Set(documents.map((d) => d.url));
    for (const d of extra) if (!have.has(d.url)) documents.push(d);
  }

  if (!documents.length && !snippets.length) {
    return {
      error: searchEnabled()
        ? "No readable sources found for this organisation."
        : "No organisation website supplied and no search key configured (set SERPER_API_KEY, BRAVE_API_KEY or TAVILY_API_KEY).",
    };
  }

  const user = [
    `TARGET ORGANISATION: ${orgName || url}`,
    department ? `DEPARTMENT OF INTEREST: ${department}` : "",
    ``,
    `You may cite ONLY these URLs:`,
    urlList(documents, snippets),
    ``,
    `SOURCE MATERIAL`,
    buildSourceMaterial(documents, snippets).slice(0, 60000),
  ].filter(Boolean).join("\n");

  const r = await chatJSON({
    system: ORG_SYSTEM,
    user,
    schema: ORG_SCHEMA,
    schemaName: "org_research",
    maxTokens: 2500,
    kind: "gen",
  });
  if (r.error) return { error: r.error };

  const v = r.value || {};
  const org = {
    name: v.name || orgName || null,
    location: v.location || null,
    type: ORG_TYPES.includes(v.type) ? v.type : null,
    relevant_department: v.relevant_department || department || null,
    ranking_notes: v.ranking_notes || null,
    recent_news: (v.recent_news || []).slice(0, 5),
    key_urls: [...new Set([...(v.key_urls || []), ...documents.map((d) => d.url)])].slice(0, 12),
    hooks: (v.hooks || []).slice(0, 5),
    facts: (v.facts || []).slice(0, 20),
  };

  const urls = {
    fetched: new Set(documents.map((d) => d.url)),
    snippet: new Set(snippets.map((s) => s.url)),
  };
  const quality = enforceSourcing(org, urls);

  return {
    org,
    sources: {
      documents: documents.map((d) => ({ url: d.url, kind: d.kind })),
      snippets: snippets.map((s) => ({ url: s.url })),
      fetched: documents.length,
      snippets_only: snippets.length,
      search_provider: search.provider,
      search_disabled: Boolean(search.disabled),
      search_errors: search.errors || [],
    },
    quality,
  };
}

// ── person research ─────────────────────────────────────────────────────────

/**
 * Research one person. Thin by design — the org half is already cached, and this
 * is the layer that reruns for every contact.
 *
 * @param {object} a
 * @param {object} a.person   { full_name, email, position, university, linkedin_url, other_urls }
 * @param {object} [a.org]    the org block, so the extractor can reject same-name strangers
 * @returns {Promise<{person?: object, sources?: object, quality?: object, error?: string}>}
 */
export async function researchPerson({ person, org }) {
  const p = person || {};
  const fullName = String(p.full_name || "").trim();
  if (!fullName) return { error: "person.full_name is required." };
  const orgName = String(p.university || org?.name || "").trim();

  const queries = [
    orgName ? `"${fullName}" ${orgName}` : `"${fullName}"`,
    p.position ? `"${fullName}" ${p.position}` : "",
    p.linkedin_url ? `${p.linkedin_url}` : `"${fullName}" linkedin`,
    orgName ? `"${fullName}" ${orgName} publications OR profile OR faculty` : "",
  ].filter(Boolean);
  const search = await multiSearch(queries, { perQuery: 4 });

  // Caller-supplied URLs are ranked ahead of anything search found: the caller
  // knows which page is actually this person, and search does not.
  const supplied = [
    ...(Array.isArray(p.other_urls) ? p.other_urls : []),
    ...(p.linkedin_url ? [p.linkedin_url] : []),
  ];
  const { fetchable, snippets } = partitionHits(
    [...supplied.map((u) => ({ url: u, title: "", snippet: "" })), ...search.results],
    MAX_PERSON_PAGES
  );
  const { documents } = await crawlPages(fetchable, { limit: MAX_PERSON_PAGES, kind: "person_page" });

  if (!documents.length && !snippets.length) {
    return {
      person: emptyPerson(p),
      sources: {
        documents: [], snippets: [], fetched: 0, snippets_only: 0,
        search_provider: search.provider, search_disabled: Boolean(search.disabled),
        search_errors: search.errors || [],
      },
      quality: { demoted: [], snippet_capped: [], kept: 0, note: "no readable sources for this person" },
    };
  }

  const user = [
    `TARGET PERSON: ${fullName}`,
    p.position ? `KNOWN POSITION (from the caller, treat as true): ${p.position}` : "",
    orgName ? `KNOWN ORGANISATION (from the caller, treat as true): ${orgName}` : "",
    p.linkedin_url ? `DECLARED LINKEDIN: ${p.linkedin_url}` : "",
    ``,
    `Use the known position and organisation to REJECT sources about a different`,
    `person with the same name. Do not blend two people.`,
    ``,
    `You may cite ONLY these URLs:`,
    urlList(documents, snippets),
    ``,
    `SOURCE MATERIAL`,
    buildSourceMaterial(documents, snippets).slice(0, 50000),
  ].filter(Boolean).join("\n");

  const r = await chatJSON({
    system: PERSON_SYSTEM,
    user,
    schema: PERSON_SCHEMA,
    schemaName: "person_research",
    maxTokens: 2500,
    kind: "gen",
  });
  if (r.error) return { error: r.error };

  const v = r.value || {};
  // Caller-supplied identity always wins over the model's reading. The caller
  // knows who they asked about; the model only saw pages that might be about them.
  const out = {
    full_name: fullName,
    email: p.email || null,
    current_title: p.position || v.current_title || null,
    current_org: v.current_org || orgName || null,
    university: orgName || v.university || null,
    program_or_degree: v.program_or_degree || null,
    grad_year: v.grad_year != null ? String(v.grad_year) : null,
    location: v.location || null,
    linkedin_url: p.linkedin_url || null,
    linkedin_headline: v.linkedin_headline || null,
    linkedin_about: v.linkedin_about ? String(v.linkedin_about).slice(0, 600) : null,
    recent_activity: (v.recent_activity || []).slice(0, 5),
    skills_interests: (v.skills_interests || []).filter(Boolean).slice(0, 8),
    notable_items: (v.notable_items || []).slice(0, 5),
    hooks: (v.hooks || []).slice(0, 5),
    facts: (v.facts || []).slice(0, 20),
  };

  const urls = {
    fetched: new Set(documents.map((d) => d.url)),
    snippet: new Set(snippets.map((s) => s.url)),
  };
  const quality = enforceSourcing(out, urls);

  return {
    person: out,
    sources: {
      documents: documents.map((d) => ({ url: d.url, kind: d.kind })),
      snippets: snippets.map((s) => ({ url: s.url })),
      fetched: documents.length,
      snippets_only: snippets.length,
      search_provider: search.provider,
      search_disabled: Boolean(search.disabled),
      search_errors: search.errors || [],
    },
    quality,
  };
}

/** The person block when research found nothing — identity only, no invented facts. */
export function emptyPerson(p) {
  return {
    full_name: String(p?.full_name || "").trim() || null,
    email: p?.email || null,
    current_title: p?.position || null,
    current_org: p?.university || null,
    university: p?.university || null,
    program_or_degree: null,
    grad_year: null,
    location: null,
    linkedin_url: p?.linkedin_url || null,
    linkedin_headline: null,
    linkedin_about: null,
    recent_activity: [],
    skills_interests: [],
    notable_items: [],
    hooks: [],
    facts: [],
  };
}

export function researchModel() {
  return process.env.OPENAI_GEN_MODEL || process.env.ANTHROPIC_GEN_MODEL || null;
}

export { aiProvider };
