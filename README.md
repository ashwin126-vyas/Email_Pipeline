# Brevo Email Pipeline

A standalone Next.js app that reads the **same Postgres `contacts` table** the
[apollo-people-app](../apollo-people-app) writes to, and lets you email those
contacts through **Brevo** (transactional REST API) — one at a time, or a whole
range at once.

This app is read-only against the database (it only `SELECT`s contacts) and
sends email via Brevo. It never writes to your DB.

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

## Notes

- Sending real email is **not undoable** — bulk sends ask for confirmation first.
- Row numbers in the `#` column are 1-based over the **currently filtered** list,
  which is exactly what the range selector uses.
- Brevo's free plan has a daily send cap and rate limits; the `/api/send` route
  caps in-flight requests at 5 to stay well under them.
