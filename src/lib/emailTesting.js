// email_testing — the whole chain in one call, with every input and output kept.
//
//   research (them)  ─┐
//                      ├─► campaign (per ORGANISATION, cached) ─► email (per PERSON)
//   radius   (us)    ─┘
//
// Four stages, three of them cached, one of them per-person. That shape is the
// requirement: everyone at one university shares a campaign, and each of them
// gets their own email underneath it.
//
// One row per run holds the input AND output of every stage, plus the two prompts
// actually sent. Six weeks later "why did we say that to them" is answerable from
// the row alone, without rerunning a crawl whose sources have since changed.
// Nothing here sends email.

import { pool } from "./db.js";
import { runResearch, orgKey } from "./personResearchStore.js";
import { currentRadiusProduct, productBlock, doNotCite, syncRadiusProduct, RADIUS_URL } from "./radiusProduct.js";
import { generateCampaign, saveCampaign, currentCampaignForOrg, campaignBlock } from "./generateCampaign.js";
import { generatePersonEmail } from "./generatePersonEmail.js";
import { generateFollowup, FOLLOWUP_STEPS } from "./generateFollowup.js";
import { aiProvider, aiModel } from "./llm.js";
import { roleForTitle, roleBlock } from "./roleObjectives.js";

export function emailTestingHint(e) {
  return /relation .*(email_testing|radius_product|radius_campaigns).* does not exist/i.test(e.message)
    ? "Research/product tables are missing. Run `npm run db:setup` to apply schema.sql."
    : e.message;
}

/**
 * Run research → product → campaign → email for one person and log the lot.
 *
 * @param {object} a
 * @param {object} a.person
 * @param {"to_person"|"on_behalf"} [a.mode]
 * @param {object} [a.target]
 * @param {string} [a.email_intent]
 * @param {string} [a.sender_context]
 * @param {object} [a.constraints]
 * @param {boolean} [a.refresh]           re-crawl research
 * @param {boolean} [a.refresh_campaign]  regenerate the org campaign
 * @param {string}  [a.run_label]
 * @returns {Promise<{id?, research?, radius?, campaign?, email?, error?}>}
 */
export async function runEmailTest({
  person,
  mode = "to_person",
  target,
  email_intent = "",
  sender_context = "",
  constraints = {},
  refresh = false,
  refresh_campaign = false,
  run_label = null,
  followup = false,
} = {}) {
  const p = person || {};
  if (!String(p.full_name || "").trim()) return { error: "person.full_name is required." };

  const key = orgKey({ university: p.university, url: p.org_url });
  const researchInput = { mode, person: p, target: target || null, email_intent, sender_context };

  // ── stage 1: research (them) ──────────────────────────────────────────────
  // The role carries what person research used to try to find, at zero marginal
  // cost after the one-time research. Set USE_ROLE_OBJECTIVES=false to fall back.
  const useRoles = String(process.env.USE_ROLE_OBJECTIVES ?? "true") !== "false";
  const roleRow = useRoles ? await roleForTitle(p.position) : null;
  const role = roleBlock(roleRow);

  const researched = await runResearch({
    mode, person: p, target, email_intent, sender_context, refresh, persist: true,
    skipPerson: Boolean(role),
  });
  if (researched.error) return { error: researched.error };
  const research = researched.research;

  // Facts a human vouched for, merged in beside the crawled ones. They are held
  // separately (see verified_facts in schema.sql) so a re-crawl cannot wipe them,
  // and they enter the contract through the same confidence floor as everything
  // else — a human assertion is treated as evidence, not as an exemption.
  if (key) {
    try {
      const { rows: vf } = await pool.query(
        `SELECT fact, source_url, confidence FROM verified_facts
          WHERE lower(org_key) = lower($1) AND is_active ORDER BY id`,
        [key]
      );
      if (vf.length) {
        // Human-vouched facts go FIRST. They were added because someone wanted
        // them used, and buried at position nine in allowed_facts they are
        // frequently skipped — it took three attempts before the generator
        // reached for one.
        research.provenance = [
          ...vf.map((f) => ({
            fact: f.fact,
            source_url: f.source_url || null,
            confidence: Number(f.confidence),
            verified_by_human: true,
          })),
          ...(research.provenance || []),
        ];
      }
    } catch { /* table missing — not a reason to fail the run */ }
  }

  // ── stage 2: radius (us) ──────────────────────────────────────────────────
  // Auto-sync on first use so a fresh database does not fail with an empty table.
  let productRow = await currentRadiusProduct();
  const radiusInput = { url: RADIUS_URL, auto_synced: false };
  if (!productRow) {
    const synced = await syncRadiusProduct();
    if (synced.error) return { error: `Product data unavailable: ${synced.error}` };
    productRow = synced.row;
    radiusInput.auto_synced = true;
  }
  const product = productBlock(productRow);
  if (product) product.do_not_cite = doNotCite(productRow);

  // ── stage 3: campaign (per organisation, cached) ──────────────────────────
  let campaignRow = key && !refresh_campaign ? await currentCampaignForOrg(key) : null;
  let campaignCached = Boolean(campaignRow);
  let campaignResult = null;

  if (!campaignRow) {
    // Lines already running at OTHER institutions. Without this the model
    // converges hard: a real batch of ten produced "Placement Ka Saathi",
    // "Placement Ka Partner", "Placement Ka Guru" and "Placement Ka King" — a
    // campaign that is per-org in the database and identical in the inbox.
    let recentLines = [];
    try {
      const { rows } = await pool.query(
        `SELECT campaign_line FROM radius_campaigns
          WHERE is_current AND campaign_line IS NOT NULL AND lower(org_key) <> lower($1)
          ORDER BY created_at DESC LIMIT 15`,
        [key || ""]
      );
      recentLines = rows.map((r) => r.campaign_line);
    } catch { /* first run, or table missing — not a reason to fail */ }

    campaignResult = await generateCampaign({
      product,
      research,
      orgName: research?.university?.name || p.university,
      recentLines,
    });
    if (campaignResult?.error) return { error: `Campaign generation failed: ${campaignResult.error}` };
    if (key) {
      campaignRow = await saveCampaign({
        orgKey: key,
        orgName: research?.university?.name || p.university,
        orgResearchId: researched.ids?.org_research_id,
        productId: productRow.id,
        result: campaignResult,
      });
    }
  }
  const campaign = campaignBlock(campaignRow) || campaignResult?.campaign || null;

  // ── stage 4: email (per person) ───────────────────────────────────────────
  // Subjects already used at this institution. The campaign is shared here by
  // design, so without this the subject line gets shared too, and a column of
  // identical subjects into one domain is what a bulk blast looks like.
  // A follow-up is the same research and the same campaign, written again for
  // someone who did not reply. Load what they already received so the generator
  // can avoid repeating it (and so the gates can check that it did not).
  let parent = null;
  let thread = [];
  if (followup) {
    // The WHOLE thread, not just the last email: validateFollowup() compares the
    // new step against every previous one, so handing it only the most recent
    // would let step 2 quietly repeat step 0.
    //
    // "Thread" means one chain of parent_id links from one first email — NOT
    // every row this person appears in. Picking the max step_number across all
    // their history stitches a step 1 from today onto a step 3 written last week
    // and calls the result step 4: the follow-up then answers an email that was
    // never sent, and the comparative gates measure it against an unrelated one.
    // Regenerating a first email starts a NEW thread, so the newest root wins.
    const { rows: roots } = await pool.query(
      `SELECT id FROM email_testing
        WHERE lower(person_email) = lower($1) AND subject IS NOT NULL AND is_valid
          AND COALESCE(step_number, 1) = 1 AND parent_id IS NULL
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [p.email || ""]
    );
    if (!roots.length) {
      return { error: `No previous email found for ${p.email || p.full_name} — generate the initial email first.` };
    }
    const { rows } = await pool.query(
      `WITH RECURSIVE chain AS (
         SELECT id, subject, body, step_number, tone, created_at, parent_id
           FROM email_testing WHERE id = $1
         UNION ALL
         SELECT c.id, c.subject, c.body, c.step_number, c.tone, c.created_at, c.parent_id
           FROM email_testing c JOIN chain ON c.parent_id = chain.id
          WHERE c.subject IS NOT NULL AND c.is_valid
       )
       SELECT DISTINCT ON (step_number) id, subject, body, step_number, tone, created_at
         FROM chain ORDER BY step_number, created_at DESC`,
      [roots[0].id]
    );
    thread = rows;
    parent = rows[rows.length - 1] || null;
  }

  let recentSubjects = [];
  if (key) {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT subject FROM email_testing
          WHERE lower(org_key) = lower($1) AND subject IS NOT NULL
          ORDER BY subject LIMIT 10`,
        [key]
      );
      recentSubjects = rows.map((r) => r.subject);
    } catch { /* no log yet, or table missing — not a reason to fail the run */ }
  }

  const emailInput = {
    mode, email_intent, sender_context, constraints, avoid_subjects: recentSubjects,
    followup, parent_id: parent?.id || null, step_number: parent ? (parent.step_number || 0) + 1 : 1,
  };
  // Follow-ups are a different job from a first email, so they go through
  // generateFollowup(): its gates are comparative (shorter than every previous
  // step, no repeated sentence, one new specific, never mention the silence).
  const step = parent ? (parent.step_number || 1) : 0;
  const email = followup
    ? await generateFollowup({
        step: Math.min(step, Math.max(...Object.keys(FOLLOWUP_STEPS).map(Number))),
        original: {
          subject: thread[0]?.subject,
          body: thread[0]?.body,
          tone: thread[0]?.tone || "formal",
          person_name: research?.person?.full_name || p.full_name,
          person_email: p.email,
          org_name: research?.university?.name || p.university,
          email_intent,
        },
        previous: thread.slice(1),
        product,
        campaign,
        research,
      })
    : await generatePersonEmail({
        research, mode, emailIntent: email_intent, senderContext: sender_context,
        constraints, product, campaign, recentSubjects, role,
      });

  // ── log every stage ───────────────────────────────────────────────────────
  const emailOutput = {
    subject: email?.subject || null,
    body: email?.body || null,
    hooks_used: email?.hooksUsed || [],
    facts_cited: email?.factsCited || [],
    warnings: email?.warnings || [],
    error: email?.error || null,
  };

  let id = null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO email_testing (
         run_label, org_key, org_name, person_name, person_email, mode, email_intent,
         person_research_id, org_research_id, radius_product_id, radius_campaign_id,
         research_input, research_output,
         radius_input, radius_output,
         campaign_input, campaign_prompt_system, campaign_prompt_user, campaign_output, campaign_cached,
         email_input, email_prompt_system, email_prompt_user, email_contract, email_output,
         subject, body, coverage, tone, warnings, is_valid, validation,
         status, provider, model, error,
         step_number, parent_id, previous_subject, previous_body)
       VALUES ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11, $12,$13, $14,$15,
               $16,$17,$18,$19,$20, $21,$22,$23,$24,$25,
               $26,$27,$28,$29,$30,$31,$32, $33,$34,$35,$36,
               $37,$38,$39,$40)
       RETURNING id`,
      [
        run_label, key || null, research?.university?.name || p.university || null,
        research?.person?.full_name || p.full_name, research?.person?.email || p.email || null,
        mode, email_intent || null,
        researched.ids?.person_research_id || null, researched.ids?.org_research_id || null,
        productRow.id, campaignRow?.id || null,
        JSON.stringify(researchInput), JSON.stringify(research),
        JSON.stringify(radiusInput), JSON.stringify(product),
        // On a cached run the campaign was not regenerated, so carry the input it
        // was ORIGINALLY built from rather than a {cached:true} stub — the point
        // of this row is to explain the result without opening another table.
        JSON.stringify(campaignResult?.input || campaignRow?.input || {}),
        campaignResult?.prompts?.system || campaignRow?.prompt_system || null,
        campaignResult?.prompts?.user || campaignRow?.prompt_user || null,
        JSON.stringify(campaign || {}), campaignCached,
        JSON.stringify(emailInput), email?.prompts?.system || null, email?.prompts?.user || null,
        JSON.stringify(email?.contract || {}), JSON.stringify(emailOutput),
        emailOutput.subject, emailOutput.body, research?.meta?.coverage || null,
        email?.contract?.tone || null, emailOutput.warnings,
        Boolean(email?.validation?.valid), JSON.stringify(email?.validation?.gates || {}),
        email?.error ? "failed" : email?.validation?.valid ? "draft" : "rejected",
        aiProvider(), aiModel("gen"),
        email?.error || null,
        parent ? (parent.step_number || 0) + 1 : 1,
        parent?.id || null, parent?.subject || null, parent?.body || null,
      ]
    );
    id = rows[0].id;
  } catch (e) {
    // Logging must never sink a run — same rule as logSend() on the send path.
    if (!/does not exist/i.test(e.message)) throw e;
  }

  return {
    id,
    research: { ...research, ids: researched.ids, cached: researched.cached },
    radius: { product, product_id: productRow.id, version: productRow.version, auto_synced: radiusInput.auto_synced },
    campaign: campaign
      ? { ...campaign, id: campaignRow?.id || null, cached: campaignCached, valid: campaignRow?.is_valid ?? campaignResult?.validation?.valid ?? null,
          validation: campaignResult?.validation?.gates || campaignRow?.validation || {} }
      : null,
    step_number: parent ? (parent.step_number || 0) + 1 : 1,
    parent_id: parent?.id || null,
    email: {
      subject: emailOutput.subject,
      body: emailOutput.body,
      hooks_used: emailOutput.hooks_used,
      facts_cited: emailOutput.facts_cited,
      warnings: emailOutput.warnings,
      valid: email?.validation?.valid ?? null,
      validation: email?.validation?.gates || {},
      error: email?.error || null,
    },
  };
}
