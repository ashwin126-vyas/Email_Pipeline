# Brevo Email Pipeline

A standalone Next.js app that reads the **same Postgres `contacts` table** the
[apollo-people-app](../apollo-people-app) writes to, and lets you email those
contacts through **Brevo** (transactional REST API) — one at a time, or a whole
range at once.

This app is **read-only against the `contacts` table** (owned by the
apollo-people-app — it only `SELECT`s it). It **does** own and write its own
tables in the same database: `email_templates`, `email_logs`, and the
automation tables (`sequences`, `sequence_steps`, `campaigns`, `enrollments`,
`suppressions`). Run `npm run db:setup` to create them.

Beyond one-off sends it also runs a **24/7 automation engine** — bulk cold email
with automatic, reply-aware follow-ups. See [Automation engine](#automation-engine).

## Setup

```bash
cd apollo-email-app
npm install
cp .env.example .env      # then fill in the values (see below)
npm run dev               # http://localhost:3001  (3001, so it can run alongside the Apollo app on 3000)
```

### Environment (`.env`)

| Variable             | What it is                                                                 |
| -------------------- | -------------------------------------------------------------------------- |
| `DATABASE_URL`       | Postgres connection string — the **same DB** as the apollo-people-app.     |
| `BREVO_API_KEY`      | Brevo API key: dashboard ▸ **SMTP & API ▸ API Keys**.                       |
| `BREVO_SENDER_EMAIL` | The "from" address. **Must be a verified sender/domain in Brevo.**         |
| `BREVO_SENDER_NAME`  | Display name shown as the sender.                                          |
| `BREVO_REPLY_TO`     | (optional) Reply-to address; defaults to the sender.                       |

> **You must verify your sender in Brevo before sending.** In the Brevo
> dashboard go to **Senders, Domains & Dedicated IPs** and either verify a
> single sender email or authenticate your domain (SPF/DKIM). Unverified senders
> are rejected.

## How it works

- **`GET /api/contacts`** — returns every `contacts` row that has a usable email.
- **`POST /api/send`** — body `{ ids, subject, html, text }`. Looks the contacts
  up fresh by `apollo_id`, personalizes per recipient, and sends one Brevo
  request each (5 concurrent). Returns a per-recipient result.
- **`src/app/page.js`** — the UI (Tailwind): a searchable contact table with a
  per-row **Send** button and a **range selector** (`From row` / `To row` →
  *Select range*) plus **Send to N selected** for bulk. The email itself is set
  in a **modal opened by the top-right "Set email" button** (template picker +
  subject + message); the draft is saved to `localStorage` and reused until you
  change it.

### Personalization tokens

Usable in the subject and message; replaced per recipient:

`{{first_name}}` · `{{name}}` · `{{company}}` · `{{title}}` · `{{email}}`

## Automation engine

A background worker turns the app into a 24/7 cold-email + follow-up engine. The
key idea: **a follow-up is not a separate system.** When we send a step we stamp
`enrollments.next_action_at = now() + next_step.delay`. The worker wakes every
couple of minutes, asks "who's due?", re-checks stop conditions, and sends the
next step — the same row just becoming due again.

### Pieces

- **Tables** (in `schema.sql`): `sequences` + `sequence_steps` (an ordered
  template list), `campaigns` (a sequence + a contact filter + warm-up caps),
  `enrollments` (per-contact state machine — who's due when), `suppressions`
  (global do-not-contact). `email_logs` gained `opened_at/clicked_at/
  bounced_at/complained_at` + `campaign_id/enrollment_id`.
- **Worker** — `npm run worker` (`worker/index.mjs`). Every ~2 min it processes
  each **active** campaign inside its send window, up to the daily cap, claiming
  due enrollments with `FOR UPDATE SKIP LOCKED` and advancing them in the same
  transaction as the send-log (crash-safe, no double-sends). Reuses the app's
  `sendEmail`/`renderTemplate`/`pool` — nothing forked.
- **Webhook** — `POST /api/brevo-webhook?secret=…` stamps delivery events onto
  `email_logs` by `message_id`, and on bounce/spam/unsubscribe adds the address
  to `suppressions` and stops its enrollments. Point Brevo's webhook here.
- **Unsubscribe** — `/api/unsubscribe` (one-click, RFC 8058). Every automated
  send carries `List-Unsubscribe` headers + a footer link.
- **Reply detection** (optional, env-gated) — polls the reply mailbox over IMAP,
  matches the sender to an active enrollment, classifies the reply with Claude
  (`interested/not_interested/out_of_office/unsubscribe/other`), and stops or
  defers the sequence. Without `ANTHROPIC_API_KEY` it degrades to "any reply →
  stop"; without `IMAP_*` it's dormant.

### Using it (UI: the **Campaigns** tab)

1. Create templates (Recipients page). Use `{{first_name}}` etc. — they render
   per recipient at send time.
2. **Campaigns → Sequences**: build a sequence, e.g. step 1 now, step 2 +48h,
   step 3 +72h.
3. **New campaign**: name it, pick the sequence, set an ILIKE filter (title/
   company/industry), a **low** daily cap (warm-up!), and a send window.
4. **Enroll** the matching contacts (previews the count first), then **Start**.
5. `npm run worker` does the rest. Watch progress on the **Emailed Send** page.

### Deliverability (do this BEFORE going live)

- Authenticate your sending domain in Brevo (SPF/DKIM/DMARC) and set
  `BREVO_SENDER_EMAIL` to an address on it. Automating from an unauthenticated /
  rewritten address just sends spam faster.
- Start the daily cap **low** (20–50) and ramp over 2–3 weeks.
- Keep the app + worker on always-on hosting with a stable HTTPS URL (for the
  webhook + unsubscribe links) — not localhost, not ngrok.

See `.env.example` for every automation variable.

## Notes

- Sending real email is **not undoable** — bulk sends ask for confirmation first.
- Row numbers in the `#` column are 1-based over the **currently filtered** list,
  which is exactly what the range selector uses.
- Brevo's free plan has a daily send cap and rate limits; sends cap in-flight
  requests at 5 to stay well under them.
