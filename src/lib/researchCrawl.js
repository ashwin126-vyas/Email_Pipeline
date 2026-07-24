// Multi-page research crawl — the fix for the biggest research-quality defect.
//
// The first version of this pipeline fetched ONE page (the homepage), summarised
// it into prose, and extracted facts from the prose. The audit showed what that
// costs:
//   · 0/27 institutions had a placement rate, cohort size or placement cell name,
//     because those live on /placement and we never opened it
//   · 155 facts claimed confidence >= 0.8 with no source_url, because a prose
//     summary has no URLs in it for the model to cite
//   · 0/7 "recent events" carried a date, because homepages rarely date anything
//
// So: fetch the pages that actually hold the facts, keep each page's URL, and
// hand the extractor labelled documents it can cite. Bounded and polite —
// at most MAX_PAGES fetches per institution, sequential, short timeouts.

const MAX_PAGES = 6;
const PAGE_TIMEOUT_MS = 12000;
const PER_PAGE_CHARS = 9000;
const UA = "Mozilla/5.0 (compatible; RadiusAI-research/1.0; +outreach research)";

// Paths worth trying directly, best first. Indian institution sites are highly
// conventional about these.
const CANDIDATE_PATHS = [
  "/placement", "/placements", "/training-and-placement", "/training-placement",
  "/tpo", "/placement-cell", "/career", "/careers", "/about", "/about-us",
  "/news", "/events", "/announcements",
];

// Link text / href patterns that suggest a page worth reading.
const LINK_PATTERNS = [
  { re: /plac(e|ing)ment|training\s*&?\s*placement|tpo|recruiter/i, kind: "placement", weight: 100 },
  { re: /achievement|award|ranking|nirf|naac|accredit/i, kind: "accreditation", weight: 70 },
  { re: /news|event|announce|media|press|latest/i, kind: "news", weight: 60 },
  { re: /about|profile|overview|vision|history|alumni/i, kind: "about", weight: 40 },
];

// Pages that look relevant by name but carry no extractable facts. Feeding these
// to the extractor actively hurts: an "approvals & affiliations" page pushes it
// toward "affiliated to GTU", which is boilerplate true of hundreds of colleges
// and gets rejected downstream as a non-specific anchor. Spending crawl budget
// here means NOT spending it on the placement page.
const JUNK_PATH = /policy|policies|privacy|conduct|terms|disclaimer|sitemap|login|signin|register|approval|affiliation|grievance|committee|circular|tender|fee|syllabus|admission-form|anti-ragging|rti|mandatory-disclosure/i;

function isPublicHttp(u) {
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost") return false;
  if (/^(127\.|0\.|10\.|169\.254\.|192\.168\.)/.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  return true;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) return { url, error: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") || "";
    if (ct && !/html|text/i.test(ct)) return { url, error: `not html (${ct.split(";")[0]})` };
    const html = (await res.text()).slice(0, 400000);
    const text = htmlToText(html);
    if (!text || text.length < 60) return { url: res.url || url, error: "no readable text" };
    return { url: res.url || url, html, text: text.slice(0, PER_PAGE_CHARS) };
  } catch (e) {
    return { url, error: e.name === "AbortError" ? "timed out" : e.message || "fetch failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** Pull same-host links out of a homepage and score them by usefulness. */
function discoverLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const found = new Map();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, href, inner] = m;
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (u.hostname !== base.hostname) continue;
    if (!isPublicHttp(u)) continue;
    if (/\.(pdf|jpe?g|png|gif|zip|docx?|pptx?|xlsx?)$/i.test(u.pathname)) continue;
    if (JUNK_PATH.test(u.pathname)) continue;
    u.hash = "";
    const label = `${htmlToText(inner)} ${u.pathname}`;
    for (const { re: pat, kind, weight } of LINK_PATTERNS) {
      if (!pat.test(label)) continue;
      const key = u.href;
      const prev = found.get(key);
      if (!prev || prev.weight < weight) found.set(key, { url: u.href, kind, weight });
    }
  }
  return [...found.values()].sort((a, b) => b.weight - a.weight);
}

/**
 * Crawl one institution's site and return the documents worth extracting from.
 *
 * @param {string} rawUrl
 * @returns {Promise<{documents?: Array<{url,text,kind}>, error?: string, tried?: number}>}
 */
export async function crawlInstitution(rawUrl) {
  let root;
  try {
    root = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return { error: "invalid website url" };
  }
  if (!isPublicHttp(root)) return { error: "host not allowed" };

  const home = await fetchPage(root.href);
  if (home.error) return { error: `homepage: ${home.error}` };

  const documents = [{ url: home.url, text: home.text, kind: "home" }];
  const seen = new Set([home.url.replace(/\/$/, "")]);

  // Prefer links the homepage actually offers; fall back to conventional paths.
  const discovered = discoverLinks(home.html || "", home.url);
  const guesses = CANDIDATE_PATHS.map((p) => ({
    url: new URL(p, root.origin).href,
    kind: /plac|tpo|career|recruit/i.test(p) ? "placement" : /news|event|announce/i.test(p) ? "news" : "about",
    weight: 10,
  }));

  // One placement page is worth more than three about pages, so keep the mix.
  const wanted = [...discovered, ...guesses];
  // Placement pages carry the facts that matter, so give them the most room.
  const byKind = { placement: 0, news: 0, about: 0, accreditation: 0 };
  const caps = { placement: 3, accreditation: 1, news: 1, about: 1 };

  for (const cand of wanted) {
    if (documents.length >= MAX_PAGES) break;
    const key = cand.url.replace(/\/$/, "");
    if (seen.has(key)) continue;
    if ((byKind[cand.kind] ?? 0) >= (caps[cand.kind] ?? 1)) continue;
    seen.add(key);
    const page = await fetchPage(cand.url);
    if (page.error) continue;
    byKind[cand.kind] = (byKind[cand.kind] || 0) + 1;
    documents.push({ url: page.url, text: page.text, kind: cand.kind });
  }

  return { documents, tried: seen.size };
}

/** Render crawled documents as a labelled, citable block for the extractor. */
export function documentsToSourceMaterial(documents) {
  return documents
    .map((d, i) => `[SOURCE ${i + 1}] kind=${d.kind} url=${d.url}\n${d.text}`)
    .join("\n\n---\n\n");
}

/** The set of URLs a fact is allowed to cite. */
export function sourceUrlSet(documents) {
  return new Set(documents.map((d) => d.url));
}
