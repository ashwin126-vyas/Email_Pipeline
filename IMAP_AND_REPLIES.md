# IMAP & Reply Handling

What `IMAP_*` does, and exactly what breaks without it.

## First: there is no auto-reply

This system **never sends an automatic response** to someone who replies. No
auto-responder exists anywhere in the code.

What reply detection actually does is **stop the follow-up sequence**. That is the
entire point. Answering a prospect is a human job.

## What IMAP is

Brevo sends mail **out**. IMAP is the only way this app sees anything coming
**back**. Two different systems, two different directions.

`worker/reply-scan.mjs` logs into the reply mailbox every
`REPLY_INTERVAL_MINUTES` (default 5), reads unread messages, and for each one:

```
parse → match sender to a contact → classify with AI → SAVE to email_replies → act
```

The "act" step is: stop the sequence, suppress the address, or (for out-of-office)
defer the next step by `OOO_DEFER_DAYS`.

It is env-gated. `replyScanEnabled()` requires **all three** of `IMAP_HOST`,
`IMAP_USER`, `IMAP_PASS`. Miss one and the whole scanner is dormant — the worker
just logs `DISABLED` and carries on sending.

## With vs without

| | IMAP configured | IMAP missing (**today**) |
|---|---|---|
| Reply reaches your mailbox | ✅ | ✅ *(delivery is unrelated to IMAP)* |
| App can see the reply | ✅ | ❌ never |
| **Saved to `email_replies`** | ✅ | ❌ **not saved at all** |
| Follow-up stops on reply | ✅ | ❌ **keeps sending** |
| Address added to suppressions | ✅ | ❌ |
| Out-of-office defers instead of stopping | ✅ | ❌ |
| "Unsubscribe" reply honoured | ✅ | ❌ |
| Auto-reply sent to the customer | ❌ never | ❌ never |

The reply still **arrives** in the mailbox either way. A human can read it. The
*application* simply never learns it happened.

## The consequences, in order of severity

**1. You keep emailing people who already answered.** A prospect replies Monday;
your 48-hour follow-up goes out Wednesday asking whether they saw your last
email. Nothing signals "automated blast" more clearly.

**2. Unsubscribe requests are silently ignored.** This one is not just
embarrassing. Because `APP_BASE_URL` is unset, `src/lib/unsubscribe.js` falls back
to a footer reading *"reply with 'unsubscribe'"*. **A reply is currently the only
unsubscribe channel offered — and nobody is reading it.** Someone can ask to be
removed and keep receiving mail. That is a compliance problem.

**3. Interested leads are lost.** The most valuable reply you can get is
indistinguishable from silence, because nothing records it.

## Why this is the easy gap to close

IMAP is **outbound** — the worker dials out to the mail server and pulls. No
public URL, no tunnel, no deployment. It works from a laptop.

That is the opposite of the Brevo webhook (bounce/complaint handling), which needs
the internet to reach *you*. Of the two gaps, IMAP is the one that can be closed
today, for free.

## Current status

`.env` has the block, with `IMAP_PASS` filled in — but One.com rejects it:

```
responseText:        Authentication failed.
serverResponseCode:  AUTHENTICATIONFAILED
```

Ruled out: the password parses cleanly from `.env` (correct length, no stray
quotes or whitespace), TLS connects, and `imap.one.com:993` returns a valid
Dovecot greeting. The credential itself is being refused.

Most likely cause: **`outreach@radiusai.online` is an alias, not a mailbox.** An
alias forwards mail and has no inbox to log into, which the server reports as an
auth failure.

**To find out:** email `outreach@radiusai.online` from a personal address.

- Arrives somewhere → it's an alias. Point `IMAP_*` at that destination mailbox.
- Bounces → no mailbox and no forward, so `BREVO_REPLY_TO` points nowhere and
  every reply so far has vanished. Fix this before anything else.
- Opens in One.com webmail at that address → real mailbox, password is wrong.

Then run `npm run imap:test` (read-only; never marks mail as read).

⚠️ Don't retry the password repeatedly — One.com appears to throttle after failed
logins, and you can get temporarily blocked.

## Gotcha once it works

`reply-scan.mjs` searches for **unseen** messages only, then marks them seen.

**If you open a reply in your mail app before the worker polls it, the worker
never processes it** — no stop, no save, follow-up goes out anyway. Use a mailbox
you don't read manually, or leave it alone during working hours.

## Related

- `email_replies` table — `schema.sql` (⚠️ gitignored; run `npm run db:setup`)
- Scanner — `worker/reply-scan.mjs`
- Classifier — `src/lib/classify.js` (needs `OPENAI_API_KEY` or
  `ANTHROPIC_API_KEY`; without either it degrades to "any reply → stop")
- Connection test — `npm run imap:test`
