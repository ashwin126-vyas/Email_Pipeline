import { pool } from "@/lib/db";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";
import { addSuppression, stopEnrollments } from "@/lib/suppress";

// Reads/writes at request time — never evaluate at build.
export const dynamic = "force-dynamic";

// GET  /api/unsubscribe?e=<email>&s=<token>  — the link a human clicks.
// POST /api/unsubscribe?e=<email>&s=<token>  — Gmail/Yahoo one-click (RFC 8058),
//   body: List-Unsubscribe=One-Click.
// Both suppress the address and stop its active enrollments.

async function doUnsubscribe(email) {
  await addSuppression(pool, { email, reason: "unsubscribed" });
  await stopEnrollments(pool, { email, status: "unsubscribed" });
}

export async function POST(req) {
  const email = new URL(req.url).searchParams.get("e") || "";
  const token = new URL(req.url).searchParams.get("s") || "";
  if (!email || !verifyUnsubscribeToken(email, token)) {
    return new Response("Invalid unsubscribe link.", { status: 400 });
  }
  try {
    await doUnsubscribe(email);
  } catch {
    /* best-effort; still 200 so the mail client marks it done */
  }
  return new Response("Unsubscribed.", { status: 200 });
}

export async function GET(req) {
  const email = new URL(req.url).searchParams.get("e") || "";
  const token = new URL(req.url).searchParams.get("s") || "";

  if (!email || !verifyUnsubscribeToken(email, token)) {
    return htmlPage(
      "Invalid link",
      "This unsubscribe link is invalid or has expired.",
      400
    );
  }

  let ok = true;
  try {
    await doUnsubscribe(email);
  } catch {
    ok = false;
  }

  return ok
    ? htmlPage(
        "You're unsubscribed",
        `${escapeHtml(email)} has been removed. You won't receive further emails from us.`
      )
    : htmlPage(
        "Something went wrong",
        "We couldn't process the request. Please reply to the email with \"unsubscribe\" and we'll remove you manually.",
        500
      );
}

function htmlPage(title, message, status = 200) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a">
<div style="max-width:480px;margin:15vh auto;padding:32px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;text-align:center">
<div style="font-size:40px">✉️</div>
<h1 style="font-size:20px;margin:12px 0 8px">${escapeHtml(title)}</h1>
<p style="color:#475569;line-height:1.6;margin:0">${message}</p>
</div></body></html>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
