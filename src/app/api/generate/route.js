import { generateSequence } from "@/lib/generateSequence";

// Calls Claude at request time — never evaluate at build.
export const dynamic = "force-dynamic";

// POST /api/generate
// Body: { productPitch, targetDescription?, tone?, steps?, senderName? }
// Returns { steps: [{subject, body}] } — DRAFTS only. Nothing is saved; the UI
// shows them for review/edit, then a separate "approve" step turns them into
// templates + a sequence. Requires ANTHROPIC_API_KEY (see .env.example).
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const result = await generateSequence({
    productPitch: body.productPitch,
    targetDescription: body.targetDescription,
    tone: body.tone,
    steps: body.steps,
    senderName: body.senderName,
  });

  if (result.error) {
    // 422 when the request was well-formed but generation couldn't proceed
    // (e.g. no API key, model refusal); the UI shows result.error inline.
    return Response.json({ error: result.error }, { status: 422 });
  }
  return Response.json({ steps: result.steps });
}
