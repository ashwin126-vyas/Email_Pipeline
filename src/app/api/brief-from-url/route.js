import { fetchSiteText } from "@/lib/siteText";
import { generateBriefFromText } from "@/lib/generateSequence";

export const dynamic = "force-dynamic";

// POST /api/brief-from-url  { url }
// Fetches the page, extracts its text, and has the AI write a reusable campaign
// brief { pitch, theme } from it — so the user never has to write a brief. Draft
// only; the UI drops it into the editable brief fields for review.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const url = (body.url || "").trim();
  if (!url) return Response.json({ error: "Enter your website URL." }, { status: 400 });

  const site = await fetchSiteText(url);
  if (site.error) return Response.json({ error: site.error }, { status: 422 });

  const brief = await generateBriefFromText({ siteText: site.text });
  if (brief.error) return Response.json({ error: brief.error }, { status: 422 });

  return Response.json({ pitch: brief.pitch, theme: brief.theme });
}
