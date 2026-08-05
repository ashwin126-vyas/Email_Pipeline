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
  // Defaults to gpt-4o-mini deliberately. OpenAI bills non-preview web_search on
  // the mini models as a FIXED 8,000-token input block per call regardless of how
  // much page content is read; every other model is billed for the lot. Measured:
  // ₹1.12 per call on gpt-4o-mini against ₹21.35 on gpt-5.6 — an 18x difference
  // that is invisible unless you look for it.
  //
  // OpenAI's built-in web_search tool. Not Google — it is OpenAI's own search —
  // but this layer only has to DISCOVER urls; researchCrawl then fetches and reads
  // them, so the discovery engine matters less than the coverage. Uses the same
  // OPENAI_API_KEY as generation, which means no second vendor and no second bill.
  openai: {
    key: () => process.env.OPENAI_API_KEY,
    async run(query, count) {
      const model = process.env.OPENAI_SEARCH_MODEL || "gpt-4o-mini";
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          tools: [{ type: "web_search" }],
          tool_choice: "required",
          input: `Search the web for: ${query}. Report what you find with sources.`,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `OpenAI search HTTP ${res.status}`);

      // Record what the search actually consumed. This was NOT instrumented when
      // the provider was added, and it turned out to be the single most expensive
      // component in the pipeline: web_search bills the $10/1k call fee PLUS every
      // token of fetched page content at the model's own rate, and the default
      // model here is a premium one. Unmeasured cost is unmanaged cost.
      const u = data?.usage || {};
      searchTokenLedger.push({
        model,
        input: u.input_tokens ?? u.prompt_tokens ?? 0,
        output: u.output_tokens ?? u.completion_tokens ?? 0,
        calls: 1,
      });

      // `sources` is the full list of URLs consulted and is usually larger than the
      // set actually cited — which is what we want, since the crawler decides what
      // is worth reading.
      const seen = new Set();
      const hits = [];
      // OpenAI appends ?utm_source=openai to every URL. Left in, the same page
      // reached two different ways looks like two sources — which is precisely
      // what corroboration must not be fooled by.
      const clean = (u) => {
        try {
          const x = new URL(u);
          for (const k of [...x.searchParams.keys()]) if (/^utm_/i.test(k)) x.searchParams.delete(k);
          return x.toString().replace(/\?$/, "");
        } catch { return u; }
      };
      const push = (rawUrl, title, snippet) => {
        const url = clean(rawUrl);
        if (!url || seen.has(url)) return;
        seen.add(url);
        hits.push({ title: title || "", url, snippet: snippet || "" });
      };
      for (const item of data.output || []) {
        for (const src of item.sources || []) push(src.url, src.title, src.snippet);
        for (const c of item.content || []) {
          for (const a of c.annotations || []) push(a.url, a.title, "");
        }
      }
      return hits.slice(0, count);
    },
  },
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

// Serper first when present (real Google). Otherwise OpenAI's own web search,
// which needs no new vendor because the key is already here for generation.
// Search usage is tracked separately from generation: the model, the rates and
// the failure modes are all different.
export const searchTokenLedger = [];
export function searchUsageTotals() {
  return searchTokenLedger.reduce(
    (t, e) => ({ calls: t.calls + 1, input: t.input + e.input, output: t.output + e.output, model: e.model }),
    { calls: 0, input: 0, output: 0, model: null }
  );
}
export function resetSearchUsage() { searchTokenLedger.length = 0; }

const ORDER = ["serper", "brave", "tavily", "openai"];

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
