import { runResearch, saveEmailGeneration, researchTableHint } from "@/lib/personResearchStore";
import { generatePersonEmail } from "@/lib/generatePersonEmail";
import { aiEnabled } from "@/lib/llm";

export const dynamic = "force-dynamic";

// POST /api/research-and-email  (RESEARCH_API_FEATURE.md)
// Body: the /research input, plus an optional `constraints` block for the
// generation half. Convenience chain of the two endpoints — same code paths, one
// round trip.
//
// Returns { research, email }. Thin coverage does NOT fail the request: research
// reports it, the email comes back honestly generic, and the warning says so.
// Deciding whether to send a generic email is the caller's call, not ours.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const mode = body.mode === "on_behalf" ? "on_behalf" : "to_person";
  const person = body.person || {};
  if (!String(person.full_name || "").trim()) {
    return Response.json({ error: "person.full_name is required." }, { status: 400 });
  }
  if (mode === "on_behalf" && !body.target) {
    return Response.json({ error: "target is required when mode is on_behalf." }, { status: 400 });
  }
  if (!aiEnabled()) {
    return Response.json(
      { error: "No AI key set. Add OPENAI_API_KEY (or ANTHROPIC_API_KEY) to .env." },
      { status: 422 }
    );
  }

  let researched;
  try {
    researched = await runResearch({
      mode,
      person,
      target: body.target,
      email_intent: body.email_intent,
      sender_context: body.sender_context,
      refresh: Boolean(body.refresh),
      persist: body.persist !== false,
    });
  } catch (e) {
    return Response.json({ error: researchTableHint(e) }, { status: 500 });
  }
  if (researched.error) return Response.json({ error: researched.error }, { status: 422 });

  const result = await generatePersonEmail({
    research: researched.research,
    mode,
    emailIntent: body.email_intent || "",
    senderContext: body.sender_context || "",
    constraints: body.constraints || {},
  });

  let generationId = null;
  try {
    generationId = await saveEmailGeneration({
      ids: researched.ids,
      mode,
      emailIntent: body.email_intent || "",
      research: researched.research,
      request: body,
      result,
    });
  } catch { /* logging must never sink a generation */ }

  if (result?.error) {
    return Response.json(
      {
        research: { ...researched.research, ids: researched.ids },
        error: result.error,
        warnings: result.warnings || [],
      },
      { status: 422 }
    );
  }

  return Response.json({
    research: { ...researched.research, ids: researched.ids, cached: researched.cached },
    email: {
      subject: result.subject,
      body: result.body,
      hooks_used: result.hooksUsed,
      facts_cited: result.factsCited,
      warnings: result.warnings,
      valid: result.validation?.valid ?? null,
      validation: result.validation?.gates || {},
      generation_id: generationId,
    },
  });
}
