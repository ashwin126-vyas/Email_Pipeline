import { generatePersonEmail } from "@/lib/generatePersonEmail";
import { saveEmailGeneration, findCurrentPerson, researchTableHint } from "@/lib/personResearchStore";
import { aiEnabled } from "@/lib/llm";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/generate-email  (RESEARCH_API_FEATURE.md)
// Body: { research, mode?, email_intent?, sender_context?,
//         constraints?: { max_words, tone_override, min_confidence } }
//
// `research` is the full /research output. As a convenience you may instead pass
// `person_research_id` (or `person_key`) and the stored research is loaded — the
// same rows /research already wrote, so nothing is re-crawled.
//
// Returns { subject, body, hooks_used, facts_cited, warnings }. Nothing is sent:
// generating is free and reversible, sending is not.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  let research = body.research;
  let ids = body.ids || {};

  if (!research && (body.person_research_id || body.person_key)) {
    try {
      const row = body.person_research_id
        ? (await pool.query(`SELECT * FROM person_research WHERE id = $1`, [body.person_research_id])).rows[0]
        : await findCurrentPerson(body.person_key);
      if (!row) return Response.json({ error: "No stored research for that id." }, { status: 404 });
      research = row.output;
      ids = { person_research_id: row.id, org_research_id: row.org_research_id };
    } catch (e) {
      return Response.json({ error: researchTableHint(e) }, { status: 500 });
    }
  }

  if (!research || typeof research !== "object") {
    return Response.json(
      { error: "research is required (the full /research output), or pass person_research_id." },
      { status: 400 }
    );
  }
  if (!aiEnabled()) {
    return Response.json(
      { error: "No AI key set. Add OPENAI_API_KEY (or ANTHROPIC_API_KEY) to .env." },
      { status: 422 }
    );
  }

  const mode = body.mode === "on_behalf" ? "on_behalf" : "to_person";
  const result = await generatePersonEmail({
    research,
    mode,
    emailIntent: body.email_intent || "",
    senderContext: body.sender_context || "",
    constraints: body.constraints || {},
  });

  if (result?.error) {
    // Still audited: a failed generation is exactly the row you want when asking
    // why an email never appeared.
    await persist({ ids, mode, body, research, result });
    return Response.json({ error: result.error, warnings: result.warnings || [] }, { status: 422 });
  }

  const generationId = await persist({ ids, mode, body, research, result });

  return Response.json({
    subject: result.subject,
    body: result.body,
    hooks_used: result.hooksUsed,
    facts_cited: result.factsCited,
    warnings: result.warnings,
    // Additive: the caller can see WHY a draft was held back rather than only that
    // it was. A rejected draft is returned, not hidden — the decision is theirs.
    valid: result.validation?.valid ?? null,
    validation: result.validation?.gates || {},
    generation_id: generationId,
  });
}

// Logging must never sink a generation — same rule as logSend() on the send path.
async function persist({ ids, mode, body, research, result }) {
  try {
    return await saveEmailGeneration({
      ids,
      mode,
      emailIntent: body.email_intent || "",
      research,
      request: { ...body, research: undefined },
      result,
    });
  } catch {
    return null;
  }
}
