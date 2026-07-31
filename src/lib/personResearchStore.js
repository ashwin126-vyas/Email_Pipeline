// Persistence + cache for the research API, and the runResearch() orchestrator
// that ties sourcing, extraction and synthesis together.
//
// The cache is the reason this is split org-from-person. Researching one
// university costs up to six page fetches and an LLM call; doing that once per
// contact would mean twenty-seven crawls of the same site to produce the same
// paragraph. So the org row is looked up by key and reused until it goes stale,
// and only the person layer reruns. It is also what keeps a campaign coherent:
// everyone at the same institution is written from the same institutional facts,
// and only the person hooks differ.
//
// Every row stores `input` and `output` verbatim. Research is probabilistic and
// the web moves; when an email is questioned six weeks later, "what did we know,
// and what did we say" has to be answerable without rerunning anything.

import { pool } from "./db.js";
import { researchOrg, researchPerson, emptyPerson, researchModel } from "./researchPerson.js";
import { synthesize } from "./synthesize.js";
import { aiProvider } from "./llm.js";
import { searchProvider } from "./search.js";

// How long an org row stays fresh. Institutional facts (department, ranking,
// location) move on a scale of months; anything faster is news, and news is
// carried by the person layer, which is never cached.
export const ORG_TTL_DAYS = Number(process.env.RESEARCH_ORG_TTL_DAYS || 30);
// Person rows are cached far more briefly: a job change is precisely the trigger
// event we are looking for, so a stale person row is a wrong email.
export const PERSON_TTL_DAYS = Number(process.env.RESEARCH_PERSON_TTL_DAYS || 7);

/** Friendly hint when the research tables are missing (db:setup not run yet). */
export function researchTableHint(e) {
  return /relation .*(org_research|person_research|person_email_generations).* does not exist/i.test(e.message)
    ? "Research tables are missing. Run `npm run db:setup` to apply schema.sql."
    : e.message;
}

const clean = (s) => String(s || "").trim();

/** Cache key for an organisation: its host when we know it, else its name. */
export function orgKey({ university, url }) {
  if (url) {
    try {
      const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
      return u.hostname.replace(/^www\./i, "").toLowerCase();
    } catch { /* fall through to the name */ }
  }
  return clean(university).toLowerCase().replace(/\s+/g, " ");
}

/**
 * Cache key for a person. Email first because it is the only identifier that is
 * both unique and the thing we will actually send to; a LinkedIn URL is second
 * because two people share a name far more often than they share a profile.
 */
export function personKey(person, orgK) {
  const p = person || {};
  if (clean(p.email)) return clean(p.email).toLowerCase();
  if (clean(p.linkedin_url)) return clean(p.linkedin_url).toLowerCase().replace(/\/$/, "");
  return `${clean(p.full_name).toLowerCase()}@${orgK || ""}`;
}

const isFresh = (ts, days) =>
  ts != null && Date.now() - new Date(ts).getTime() < days * 24 * 3600 * 1000;

// ── org rows ────────────────────────────────────────────────────────────────

export async function findCurrentOrg(key) {
  const { rows } = await pool.query(
    `SELECT * FROM org_research WHERE lower(org_key) = lower($1) AND is_current LIMIT 1`,
    [key]
  );
  return rows[0] || null;
}

/** Turn a stored row back into the in-memory org block the synthesiser expects. */
export function orgRowToBlock(row) {
  if (!row) return null;
  return {
    name: row.name,
    location: row.location,
    type: row.type,
    relevant_department: row.relevant_department,
    ranking_notes: row.ranking_notes,
    recent_news: row.recent_news || [],
    key_urls: row.key_urls || [],
    hooks: row.hooks || [],
    facts: row.facts || [],
  };
}

async function saveOrg({ key, org, sources, quality, input }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: prev } = await client.query(
      `SELECT COALESCE(max(version), 0) AS v FROM org_research WHERE lower(org_key) = lower($1)`,
      [key]
    );
    await client.query(
      `UPDATE org_research SET is_current = false WHERE lower(org_key) = lower($1) AND is_current`,
      [key]
    );
    const { rows } = await client.query(
      `INSERT INTO org_research (
         org_key, version, is_current,
         name, location, type, relevant_department, ranking_notes,
         recent_news, key_urls, hooks, facts,
         source_urls, snippet_urls, sources_checked,
         input, output, quality, provider, model, search_provider)
       VALUES ($1,$2,true, $3,$4,$5,$6,$7, $8,$9,$10,$11, $12,$13,$14, $15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        key, Number(prev[0].v) + 1,
        org.name, org.location, org.type, org.relevant_department, org.ranking_notes,
        JSON.stringify(org.recent_news || []), org.key_urls || [],
        JSON.stringify(org.hooks || []), JSON.stringify(org.facts || []),
        (sources?.documents || []).map((d) => d.url),
        (sources?.snippets || []).map((s) => s.url),
        (sources?.fetched || 0) + (sources?.snippets_only || 0),
        JSON.stringify(input || {}), JSON.stringify(org), JSON.stringify(quality || {}),
        aiProvider(), researchModel(), sources?.search_provider || null,
      ]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ── person rows ─────────────────────────────────────────────────────────────

export async function findCurrentPerson(key) {
  const { rows } = await pool.query(
    `SELECT * FROM person_research WHERE lower(person_key) = lower($1) AND is_current LIMIT 1`,
    [key]
  );
  return rows[0] || null;
}

async function savePerson({ key, orgRowId, mode, person, target, output, quality, sources, input }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: prev } = await client.query(
      `SELECT COALESCE(max(version), 0) AS v FROM person_research WHERE lower(person_key) = lower($1)`,
      [key]
    );
    await client.query(
      `UPDATE person_research SET is_current = false WHERE lower(person_key) = lower($1) AND is_current`,
      [key]
    );
    const { rows } = await client.query(
      `INSERT INTO person_research (
         person_key, version, is_current, org_research_id, mode,
         full_name, email, current_title, current_org, university,
         program_or_degree, grad_year, location,
         linkedin_url, linkedin_headline, linkedin_about,
         recent_activity, skills_interests, notable_items, hooks, facts, target,
         synthesis, provenance, coverage, sources_checked,
         input, output, quality, provider, model, search_provider)
       VALUES ($1,$2,true,$3,$4,
               $5,$6,$7,$8,$9,
               $10,$11,$12,
               $13,$14,$15,
               $16,$17,$18,$19,$20,$21,
               $22,$23,$24,$25,
               $26,$27,$28,$29,$30,$31)
       RETURNING *`,
      [
        key, Number(prev[0].v) + 1, orgRowId, mode,
        person.full_name, person.email, person.current_title, person.current_org, person.university,
        person.program_or_degree, person.grad_year, person.location,
        person.linkedin_url, person.linkedin_headline, person.linkedin_about,
        JSON.stringify(person.recent_activity || []), person.skills_interests || [],
        JSON.stringify(person.notable_items || []), JSON.stringify(person.hooks || []),
        JSON.stringify(person.facts || []), target ? JSON.stringify(target) : null,
        JSON.stringify(output.synthesis || {}), JSON.stringify(output.provenance || []),
        output.meta?.coverage || null, output.meta?.sources_checked || 0,
        JSON.stringify(input || {}), JSON.stringify(output), JSON.stringify(quality || {}),
        aiProvider(), researchModel(), sources?.search_provider || null,
      ]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ── orchestration ───────────────────────────────────────────────────────────

/**
 * Run the whole research pipeline for one request.
 *
 * @param {object} a
 * @param {"to_person"|"on_behalf"} [a.mode]
 * @param {object} a.person
 * @param {object} [a.target]        required in on_behalf mode
 * @param {string} [a.email_intent]
 * @param {string} [a.sender_context]
 * @param {boolean} [a.refresh]      bypass the cache and re-crawl
 * @param {boolean} [a.persist]      write rows (default true)
 * @returns {Promise<{research?: object, ids?: object, cached?: object, error?: string}>}
 */
export async function runResearch({
  mode = "to_person",
  person,
  target,
  email_intent = "",
  sender_context = "",
  refresh = false,
  persist = true,
} = {}) {
  const p = person || {};
  if (!clean(p.full_name)) return { error: "person.full_name is required." };
  if (mode === "on_behalf" && !clean(target?.name) && !clean(target?.org)) {
    return { error: "target.name or target.org is required when mode is on_behalf." };
  }

  const input = { mode, person: p, target: target || null, email_intent, sender_context };
  const orgName = clean(p.university);
  const key = orgKey({ university: orgName, url: p.org_url });

  // ── organisation: cached, shared by everyone at this institution ──────────
  let orgRow = null;
  let orgBlock = null;
  let orgSources = null;
  let orgFromCache = false;

  if (key) {
    if (persist && !refresh) {
      try {
        const cached = await findCurrentOrg(key);
        if (cached && isFresh(cached.researched_at, ORG_TTL_DAYS)) {
          orgRow = cached;
          orgBlock = orgRowToBlock(cached);
          orgSources = { fetched: (cached.source_urls || []).length, snippets_only: (cached.snippet_urls || []).length, search_provider: cached.search_provider };
          orgFromCache = true;
        }
      } catch (e) {
        // A missing table must not sink research — it degrades to uncached.
        if (!/does not exist/i.test(e.message)) throw e;
      }
    }

    if (!orgBlock) {
      const r = await researchOrg({
        name: orgName,
        url: p.org_url,
        department: p.department,
        field: p.position,
      });
      // An org we cannot research is not fatal: the person layer may still carry
      // the email, and coverage will report honestly on what we ended up with.
      if (r.org) {
        orgBlock = r.org;
        orgSources = r.sources;
        if (persist) {
          try {
            orgRow = await saveOrg({ key, org: r.org, sources: r.sources, quality: r.quality, input });
          } catch (e) {
            if (!/does not exist/i.test(e.message)) throw e;
          }
        }
      } else {
        orgSources = { fetched: 0, snippets_only: 0, error: r.error, search_provider: searchProvider() };
      }
    }
  }

  // ── person: the layer that reruns for every contact ───────────────────────
  // Cached far more briefly than the org (PERSON_TTL_DAYS, default 7): a job
  // change is precisely the trigger event we are hunting for, so a stale person
  // row produces a confidently wrong email. Within the window, though,
  // regenerating an email for someone researched this morning should not re-crawl
  // them — the research is the expensive half and none of it has moved.
  const pKey = personKey(p, key);
  if (persist && !refresh) {
    try {
      const cached = await findCurrentPerson(pKey);
      // Mode is part of the key in effect: an on_behalf synthesis answers a
      // different question from a to_person one, so they must not share a row.
      if (cached && cached.mode === mode && isFresh(cached.researched_at, PERSON_TTL_DAYS) && cached.output) {
        const research = cached.output;
        research.meta = { ...research.meta, person_cached: true, org_cached: orgFromCache };
        return {
          research,
          ids: { org_research_id: cached.org_research_id || orgRow?.id || null, person_research_id: cached.id },
          cached: { org: orgFromCache, person: true },
        };
      }
    } catch (e) {
      if (!/does not exist/i.test(e.message)) throw e;
    }
  }

  const personResult = await researchPerson({ person: p, org: orgBlock });
  if (personResult.error) return { error: personResult.error };
  const personBlock = personResult.person || emptyPerson(p);

  // ── target (on_behalf only) ───────────────────────────────────────────────
  let targetBlock = null;
  let targetSources = null;
  if (mode === "on_behalf" && target) {
    const tr = await researchPerson({
      person: {
        full_name: target.name,
        position: target.role,
        university: target.org,
        linkedin_url: target.linkedin_url,
      },
      org: orgBlock,
    });
    if (tr.person) {
      targetBlock = { ...tr.person, role: target.role || tr.person.current_title, org: target.org || tr.person.current_org };
      targetSources = tr.sources;
    }
  }

  const sourcesChecked =
    (orgSources?.fetched || 0) + (orgSources?.snippets_only || 0) +
    (personResult.sources?.fetched || 0) + (personResult.sources?.snippets_only || 0) +
    (targetSources?.fetched || 0) + (targetSources?.snippets_only || 0);

  const research = synthesize({
    mode,
    person: personBlock,
    org: orgBlock,
    target: targetBlock,
    sourcesChecked,
    emailIntent: email_intent,
    senderContext: sender_context,
  });

  research.meta.org_cached = orgFromCache;
  research.meta.search_provider = searchProvider();
  research.meta.search_disabled = !searchProvider();
  research.meta.ai_provider = aiProvider();

  // ── persist ───────────────────────────────────────────────────────────────
  let personRow = null;
  if (persist) {
    try {
      personRow = await savePerson({
        key: pKey,
        orgRowId: orgRow?.id || null,
        mode,
        person: personBlock,
        target: targetBlock,
        output: research,
        quality: { person: personResult.quality, org: orgFromCache ? "cached" : undefined },
        sources: personResult.sources,
        input,
      });
    } catch (e) {
      if (!/does not exist/i.test(e.message)) throw e;
      research.meta.persisted = false;
      research.meta.persist_error = "research tables missing — run npm run db:setup";
    }
  }

  return {
    research,
    ids: { org_research_id: orgRow?.id || null, person_research_id: personRow?.id || null },
    cached: { org: orgFromCache },
  };
}

/** Persist one /generate-email call — draft or rejected, never sent. */
export async function saveEmailGeneration({ ids, mode, emailIntent, research, request, result }) {
  const val = result?.validation;
  const output = {
    subject: result?.subject || null,
    body: result?.body || null,
    hooks_used: result?.hooksUsed || [],
    facts_cited: result?.factsCited || [],
    warnings: result?.warnings || [],
  };
  const { rows } = await pool.query(
    `INSERT INTO person_email_generations (
       person_research_id, org_research_id, mode, email_intent,
       person_name, person_email,
       prompt_system, prompt_user, prompt_version,
       input, input_contract, output,
       subject, body, hooks_used, facts_cited, warnings, coverage, tone,
       is_valid, validation, status, provider, model, error)
     VALUES ($1,$2,$3,$4, $5,$6, $7,$8,$9, $10,$11,$12,
             $13,$14,$15,$16,$17,$18,$19, $20,$21,$22,$23,$24,$25)
     RETURNING id`,
    [
      ids?.person_research_id || null, ids?.org_research_id || null, mode, emailIntent || null,
      research?.person?.full_name || null, research?.person?.email || null,
      result?.prompts?.system || "", result?.prompts?.user || "", result?.prompts?.version || null,
      JSON.stringify(request || {}), JSON.stringify(result?.contract || {}), JSON.stringify(output),
      output.subject, output.body, output.hooks_used, JSON.stringify(output.facts_cited),
      output.warnings, research?.meta?.coverage || null, result?.contract?.tone || null,
      Boolean(val?.valid), JSON.stringify(val?.gates || {}),
      result?.error ? "failed" : val?.valid ? "draft" : "rejected",
      aiProvider(), researchModel(), result?.error || null,
    ]
  );
  return rows[0].id;
}
