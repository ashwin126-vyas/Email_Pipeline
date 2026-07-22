// Fetch a public web page and return its readable text — used to auto-write a
// campaign brief from the user's own website (so they don't have to write one).
// Server-side only. Bounded: 10s timeout, size caps, and a basic guard against
// pointing it at localhost / private ranges.

export async function fetchSiteText(rawUrl) {
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return { error: "Enter a valid website URL (e.g. https://radiusai.online)." };
  }
  if (!/^https?:$/.test(u.protocol)) return { error: "URL must start with http:// or https://." };
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    /^(127\.|0\.|10\.|169\.254\.|192\.168\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return { error: "That host isn't allowed." };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(u.href, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (BrevoPipeline brief-fetch)" },
    });
    if (!res.ok) return { error: `Couldn't fetch the site (HTTP ${res.status}).` };
    const html = (await res.text()).slice(0, 300000); // cap raw HTML
    const text = htmlToText(html);
    if (!text || text.length < 40) return { error: "Couldn't find readable text on that page." };
    return { text: text.slice(0, 12000) }; // cap what we send to the model
  } catch (e) {
    return { error: e.name === "AbortError" ? "Fetching the site timed out." : e.message || "Fetch failed." };
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}
