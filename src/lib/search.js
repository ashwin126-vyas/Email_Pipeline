// Pluggable web search — the URL-discovery half of the research API.
//
// The institution pipeline could assume it already knew the website to crawl
// (companies.website). Person research cannot: given "Priya Nair, Assistant
// Professor, NIT Trichy" there is no URL to start from, and RESEARCH_API_FEATURE.md
// is explicit that we "do not guess URLs". So search finds candidate URLs and the
// crawler reads them; a search hit on its own is never treated as a fetched page.
//
// Provider is auto-detected from whichever key is set, mirroring how llm.js picks
// OpenAI vs Anthropic — no SDKs, one raw fetch each. With no key set the whole
// module goes dormant and research falls back to the URLs the caller supplied,
// which is the documented degraded mode, not an error.

const PROVIDERS = {
  serper: {
    key: () => process.env.SERPER_API_KEY,
    async run(query, count, key) {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": key, "content-type": "application/json" },
        body: JSON.stringify({ q: query, num: count }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || `Serper returned HTTP ${res.status}`);
      return (data.organic || []).map((r) => ({ url: r.link, title: r.title, snippet: r.snippet }));
    },
  },
  brave: {
    key: () => process.env.BRAVE_API_KEY,
    async run(query, count, key) {
      const u = new URL("https://api.search.brave.com/res/v1/web/search");
      u.searchParams.set("q", query);
      u.searchParams.set("count", String(count));
      const res = await fetch(u, {
        headers: { "X-Subscription-Token": key, accept: "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || `Brave returned HTTP ${res.status}`);
      return (data?.web?.results || []).map((r) => ({ url: r.url, title: r.title, snippet: r.description }));
    },
  },
  tavily: {
    key: () => process.env.TAVILY_API_KEY,
    async run(query, count, key) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: key, query, max_results: count }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Tavily returned HTTP ${res.status}`);
      return (data.results || []).map((r) => ({ url: r.url, title: r.title, snippet: r.content }));
    },
  },
};

const ORDER = ["serper", "brave", "tavily"];

/** Which provider will run, or null when no search key is configured. */
export function searchProvider() {
  return ORDER.find((name) => PROVIDERS[name].key()) || null;
}

export function searchEnabled() {
  return searchProvider() !== null;
}

/**
 * One search. Never throws: research must degrade, not fail, when search is
 * unavailable or rate-limited.
 *
 * @param {string} query
 * @param {{count?: number}} [opts]
 * @returns {Promise<{results: Array<{url,title,snippet}>, provider: string|null, error?: string, disabled?: boolean}>}
 */
export async function webSearch(query, { count = 6 } = {}) {
  const name = searchProvider();
  if (!name) return { results: [], provider: null, disabled: true };
  const q = String(query || "").trim();
  if (!q) return { results: [], provider: name };

  try {
    const raw = await PROVIDERS[name].run(q, Math.min(Math.max(count, 1), 10), PROVIDERS[name].key());
    const seen = new Set();
    const results = [];
    for (const r of raw) {
      if (!r?.url || seen.has(r.url)) continue;
      seen.add(r.url);
      results.push({
        url: r.url,
        title: String(r.title || "").slice(0, 300),
        snippet: String(r.snippet || "").slice(0, 1000),
      });
    }
    return { results, provider: name };
  } catch (e) {
    return { results: [], provider: name, error: e.message || "search failed" };
  }
}

/**
 * Run several queries and merge the hits, keeping the best rank per URL and
 * remembering which query surfaced it (useful when deciding what a page is for).
 *
 * @param {string[]} queries
 * @returns {Promise<{results: Array<{url,title,snippet,rank,query}>, provider: string|null, queries: number, errors: string[], disabled?: boolean}>}
 */
export async function multiSearch(queries, { perQuery = 5 } = {}) {
  const list = [...new Set((queries || []).map((q) => String(q || "").trim()).filter(Boolean))];
  if (!list.length || !searchEnabled()) {
    return { results: [], provider: searchProvider(), queries: 0, errors: [], disabled: !searchEnabled() };
  }

  const settled = await Promise.all(list.map((q) => webSearch(q, { count: perQuery })));
  const byUrl = new Map();
  const errors = [];
  settled.forEach((r, qi) => {
    if (r.error) errors.push(`${list[qi]}: ${r.error}`);
    r.results.forEach((hit, i) => {
      const prev = byUrl.get(hit.url);
      if (prev && prev.rank <= i) return;
      byUrl.set(hit.url, { ...hit, rank: i, query: list[qi] });
    });
  });

  return {
    results: [...byUrl.values()].sort((a, b) => a.rank - b.rank),
    provider: searchProvider(),
    queries: list.length,
    errors,
  };
}
