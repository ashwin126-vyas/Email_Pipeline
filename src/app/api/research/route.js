import { runResearch, researchTableHint } from "@/lib/personResearchStore";
import { aiEnabled } from "@/lib/llm";

// Crawls, calls the model and touches Postgres — never evaluate at build.
export const dynamic = "force-dynamic";

// POST /api/research  (RESEARCH_API_FEATURE.md)
// Body: { mode?, person{full_name,email,position,university,linkedin_url,other_urls},
//         target?, email_intent?, sender_context?, refresh?, persist? }
//
// Returns the research output schema: { person, university, synthesis, provenance, meta }
// (+ target in on_behalf mode). The organisation half is cached and shared by
// everyone at the same institution; only the person layer reruns per contact,
// so calling this for a second contact at the same university is cheap.
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
      { error: "No AI key set. Add OPENAI_API_KEY to .env." },
      { status: 422 }
    );
  }

  try {
    const r = await runResearch({
      mode,
      person,
      target: body.target,
      email_intent: body.email_intent,
      sender_context: body.sender_context,
      refresh: Boolean(body.refresh),
      persist: body.persist !== false,
    });
    // 422: the request was well-formed but research could not proceed (nothing
    // readable, model refusal). The caller decides whether to send generic.
    if (r.error) return Response.json({ error: r.error }, { status: 422 });

    return Response.json({ ...r.research, ids: r.ids, cached: r.cached });
  } catch (e) {
    return Response.json({ error: researchTableHint(e) }, { status: 500 });
  }
}
