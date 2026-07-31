"use client";

// Generation — the read-out for the whole outreach chain:
//
//   research (them) + radius (us) ─► campaign (per ORGANISATION) ─► email (per PERSON) ─► follow-ups
//
// Everything on this page is a draft. Generating is free and reversible;
// sending is not, and nothing here sends. That is why a rejected email is still
// shown in full with the failing gate named rather than hidden — the point of
// the page is to read what the model produced and why it did or did not pass.
//
// The campaign is deliberately shared across an institution and the email is
// deliberately per person, so both are shown together: a campaign line that
// looks fine alone can still produce twenty-seven near-identical emails, and
// only seeing them side by side makes that visible.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppHeader from "@/components/AppHeader";
import Pagination from "@/components/Pagination";
import {
  btnPrimary,
  btnGhostSm,
  inputCls,
  labelCls,
  codeCls,
  sectionCard,
  sectionHead,
  thCls,
  tdCls,
} from "@/lib/ui";

const FORM_KEY = "radiusGenerationForm.v1";
const PAGE_SIZE = 10;

const STATUS_PILL = {
  draft: "bg-emerald-100 text-emerald-700",
  approved: "bg-blue-100 text-blue-700",
  rejected: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-700",
  sent: "bg-slate-200 text-slate-600",
};

// rateCoverage() returns exactly these three.
const COVERAGE_PILL = {
  high: "bg-emerald-100 text-emerald-700",
  partial: "bg-blue-100 text-blue-700",
  thin: "bg-amber-100 text-amber-800",
};

const EMPTY_FORM = {
  full_name: "",
  email: "",
  position: "",
  university: "",
  org_url: "",
  linkedin_url: "",
  other_urls: "",
  email_intent: "",
  sender_context: "",
  run_label: "",
  mode: "to_person",
  target_name: "",
  target_role: "",
  target_org: "",
  target_linkedin: "",
  max_words: "",
  tone_override: "",
  refresh: false,
  refresh_campaign: false,
};

/* ── small shared bits ────────────────────────────────────────────────────── */

const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;

const when = (ts) =>
  ts
    ? new Date(ts).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

function Pill({ tone = "slate", children, title }) {
  const map = {
    slate: "bg-slate-100 text-slate-600",
    blue: "bg-blue-100 text-blue-700",
    green: "bg-emerald-100 text-emerald-700",
    amber: "bg-amber-100 text-amber-800",
    red: "bg-red-100 text-red-700",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${map[tone] || map.slate}`}
    >
      {children}
    </span>
  );
}

function Section({ title, subtitle, right, children }) {
  return (
    <section className={sectionCard}>
      <div className={sectionHead}>
        <div className="mr-auto">
          <h2 className="text-sm font-bold text-slate-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
        {right}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

// The gates, all of them, pass and fail alike. A validator you only see when it
// fails is a validator nobody trusts — showing the full list is what makes
// "valid" mean something.
function Gates({ gates }) {
  const entries = Object.entries(gates || {});
  if (!entries.length) return <p className="text-xs text-slate-400">No validation recorded.</p>;
  const failed = entries.filter(([, g]) => !g?.pass);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([name, g]) => (
          <span
            key={name}
            title={g?.detail || (g?.pass ? "passed" : "failed")}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px] ${
              g?.pass ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700 ring-1 ring-red-200"
            }`}
          >
            {g?.pass ? "✓" : "✕"} {name}
          </span>
        ))}
      </div>
      {failed.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {failed.map(([name, g]) => (
            <li key={name}>
              <span className="font-semibold">{name}</span>
              {g?.detail ? ` — ${g.detail}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Warnings({ items }) {
  if (!items?.length) return null;
  return (
    <ul className="space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
      {items.map((w, i) => (
        <li key={i}>⚠ {w}</li>
      ))}
    </ul>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

function Collapsible({ title, children, defaultOpen = false, onOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const opened = useRef(defaultOpen);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !opened.current) {
      opened.current = true;
      onOpen?.();
    }
  }

  return (
    <div className="rounded-lg border border-slate-200">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
      >
        <span className="text-slate-400">{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && <div className="border-t border-slate-100 px-3 py-3">{children}</div>}
    </div>
  );
}

function CopyButton({ text, label = "Copy" }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={btnGhostSm}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text || "");
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked (http origin, denied permission) — not worth an error banner */
        }
      }}
    >
      {done ? "✓ Copied" : `⧉ ${label}`}
    </button>
  );
}

/* ── the run form ─────────────────────────────────────────────────────────── */

function RunForm({ onRan, onError, onFlash }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const hydrated = useRef(false);

  // Same pattern as the composer draft on Recipients: hydrate first, and don't
  // let the persist effect write the empty initial state over what was stored.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(FORM_KEY) || "null");
      if (saved) setForm({ ...EMPTY_FORM, ...saved });
    } catch {
      /* corrupt draft — start clean */
    }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify({ ...form, refresh: false, refresh_campaign: false }));
    } catch {
      /* storage full or disabled */
    }
  }, [form]);

  // A run crawls up to six pages and makes two LLM calls, so it is a 30–90s
  // wait. A spinner with no clock reads as a hang.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  async function run(e) {
    e.preventDefault();
    if (!form.full_name.trim()) return onError("A person's full name is required.");
    if (form.mode === "on_behalf" && !form.target_name.trim()) {
      return onError("On-behalf mode needs a target person.");
    }

    setRunning(true);
    setElapsed(0);
    onError("");
    try {
      const constraints = {};
      if (form.max_words) constraints.max_words = Number(form.max_words);
      if (form.tone_override) constraints.tone_override = form.tone_override;

      const res = await fetch("/api/email-testing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: form.mode,
          person: {
            full_name: form.full_name.trim(),
            email: form.email.trim() || undefined,
            position: form.position.trim() || undefined,
            university: form.university.trim() || undefined,
            org_url: form.org_url.trim() || undefined,
            linkedin_url: form.linkedin_url.trim() || undefined,
            other_urls: form.other_urls
              .split(/[\n,]/)
              .map((u) => u.trim())
              .filter(Boolean),
          },
          target:
            form.mode === "on_behalf"
              ? {
                  full_name: form.target_name.trim(),
                  role: form.target_role.trim() || undefined,
                  org: form.target_org.trim() || undefined,
                  linkedin_url: form.target_linkedin.trim() || undefined,
                }
              : undefined,
          email_intent: form.email_intent.trim() || undefined,
          sender_context: form.sender_context.trim() || undefined,
          constraints,
          refresh: form.refresh,
          refresh_campaign: form.refresh_campaign,
          run_label: form.run_label.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");

      onFlash(
        data.email?.valid
          ? `Generated a draft for ${form.full_name.trim()}.`
          : "Generated — the email did not pass every gate, so it is stored as rejected."
      );
      onRan(data.id);
    } catch (err) {
      onError(err.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <form onSubmit={run} className={`${sectionCard} lg:sticky lg:top-20`}>
      <div className={sectionHead}>
        <div className="mr-auto">
          <h2 className="text-sm font-bold text-slate-900">New generation</h2>
          <p className="mt-0.5 text-xs text-slate-500">Research → campaign → email. Nothing is sent.</p>
        </div>
        <button
          type="button"
          className={btnGhostSm}
          onClick={() => setForm(EMPTY_FORM)}
          disabled={running}
          title="Clear the form"
        >
          Clear
        </button>
      </div>

      <div className="space-y-3 px-5 py-4">
        <Field label="Full name *">
          <input className={inputCls} value={form.full_name} onChange={set("full_name")} placeholder="Dr. Anjali Mehta" />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Position">
            <input className={inputCls} value={form.position} onChange={set("position")} placeholder="Training & Placement Officer" />
          </Field>
          <Field label="Email">
            <input className={inputCls} value={form.email} onChange={set("email")} placeholder="tpo@college.ac.in" />
          </Field>
        </div>

        <Field label="University / organisation" hint="Also the cache key for the org research and its campaign.">
          <input className={inputCls} value={form.university} onChange={set("university")} placeholder="Sardar Patel College of Engineering" />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Org URL">
            <input className={inputCls} value={form.org_url} onChange={set("org_url")} placeholder="https://college.ac.in" />
          </Field>
          <Field label="LinkedIn URL" hint="Routing only — LinkedIn is never fetched.">
            <input className={inputCls} value={form.linkedin_url} onChange={set("linkedin_url")} />
          </Field>
        </div>

        <Field label="Email intent" hint="What this email is for, in a sentence.">
          <textarea
            rows={2}
            className={`${inputCls} resize-y`}
            value={form.email_intent}
            onChange={set("email_intent")}
            placeholder="Introduce RadiusAI to their placement cell before the next placement season."
          />
        </Field>

        <Collapsible title="More inputs">
          <div className="space-y-3">
            <Field label="Sender context">
              <textarea rows={2} className={`${inputCls} resize-y`} value={form.sender_context} onChange={set("sender_context")} />
            </Field>

            <Field label="Other URLs" hint="One per line. Read directly, no search needed.">
              <textarea rows={2} className={`${inputCls} resize-y font-mono text-xs`} value={form.other_urls} onChange={set("other_urls")} />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Mode">
                <select className={inputCls} value={form.mode} onChange={set("mode")}>
                  <option value="to_person">To person</option>
                  <option value="on_behalf">On behalf of someone</option>
                </select>
              </Field>
              <Field label="Run label" hint="Tag for a batch, e.g. gtu-july.">
                <input className={inputCls} value={form.run_label} onChange={set("run_label")} />
              </Field>
            </div>

            {form.mode === "on_behalf" && (
              <div className="space-y-3 rounded-lg bg-slate-50 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Target (researched as a second person)
                </p>
                <input className={inputCls} value={form.target_name} onChange={set("target_name")} placeholder="Target full name *" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <input className={inputCls} value={form.target_role} onChange={set("target_role")} placeholder="Role" />
                  <input className={inputCls} value={form.target_org} onChange={set("target_org")} placeholder="Organisation" />
                </div>
                <input className={inputCls} value={form.target_linkedin} onChange={set("target_linkedin")} placeholder="LinkedIn URL" />
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Max words" hint="Default 150.">
                <input className={inputCls} type="number" min="40" max="400" value={form.max_words} onChange={set("max_words")} />
              </Field>
              <Field label="Tone override">
                <select className={inputCls} value={form.tone_override} onChange={set("tone_override")}>
                  <option value="">Recommended by research</option>
                  <option value="formal">Formal</option>
                  <option value="peer">Peer</option>
                  <option value="warm">Warm</option>
                </select>
              </Field>
            </div>
          </div>
        </Collapsible>

        <div className="space-y-1.5 rounded-lg bg-slate-50 px-3 py-2.5">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={form.refresh} onChange={set("refresh")} className="h-3.5 w-3.5" />
            Re-crawl research (ignore the cache)
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={form.refresh_campaign}
              onChange={set("refresh_campaign")}
              className="h-3.5 w-3.5"
            />
            Regenerate the org campaign
          </label>
          <p className="text-[11px] text-slate-400">
            Left off, a second contact at the same institution reuses the cached research and campaign — which is what
            keeps a campaign consistent across everyone there.
          </p>
        </div>

        <button className={`${btnPrimary} w-full`} disabled={running}>
          {running ? `Generating… ${elapsed}s` : "Generate"}
        </button>
        {running && (
          <p className="text-center text-[11px] text-slate-400">
            Crawling pages and making two model calls — usually 30–90s.
          </p>
        )}
      </div>
    </form>
  );
}

/* ── the campaign (org-level, shared) ─────────────────────────────────────── */

function CampaignPanel({ run }) {
  const c = run.campaign_output || {};
  if (!c.campaign_line && !c.big_idea) {
    return (
      <Section title="Campaign" subtitle="Per organisation, cached and shared.">
        <p className="text-sm text-slate-400">No campaign was recorded for this run.</p>
      </Section>
    );
  }

  return (
    <Section
      title="Campaign"
      subtitle={`One idea for all of ${run.org_name || run.org_key || "the organisation"} — every contact there writes underneath it.`}
      right={
        <div className="flex items-center gap-1.5">
          {run.campaign_cached ? <Pill tone="blue">Cached</Pill> : <Pill tone="green">Newly generated</Pill>}
          {run.campaign_valid === false && <Pill tone="amber">Gates failed</Pill>}
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl bg-gradient-to-br from-blue-50 to-slate-50 px-5 py-4 text-center ring-1 ring-blue-100">
          <p className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">{c.campaign_line || "—"}</p>
          {c.line_meaning && <p className="mt-1.5 text-sm italic text-slate-500">“{c.line_meaning}”</p>}
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ["Theme", c.theme],
            ["Big idea", c.big_idea],
            ["Pain framing", c.pain_framing],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-slate-200 px-3 py-2.5">
              <p className={labelCls}>{k}</p>
              <p className="text-sm text-slate-700">{v || "—"}</p>
            </div>
          ))}
        </div>

        {c.talking_points?.length > 0 && (
          <div>
            <p className={labelCls}>Talking points</p>
            <ul className="space-y-1.5">
              {c.talking_points.map((t, i) => (
                <li key={i} className="flex gap-2 text-sm text-slate-700">
                  <span className="text-blue-400">▪</span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {c.subject_angles?.length > 0 && (
            <div>
              <p className={labelCls}>Subject angles</p>
              <div className="flex flex-wrap gap-1.5">
                {c.subject_angles.map((s, i) => (
                  <span key={i} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}
          {c.cta && (
            <div>
              <p className={labelCls}>Call to action</p>
              <p className="text-sm text-slate-700">{c.cta}</p>
            </div>
          )}
        </div>

        <div>
          <p className={labelCls}>Campaign gates</p>
          <Gates gates={run.campaign_validation} />
        </div>

        {/* The other half of the campaign input: what WE are. Worth having on the
            same screen — an empty proof list is why the line claims a category
            rather than a statistic. */}
        <Collapsible title="What we pitched with (RadiusAI, crawled from the site)">
          <div className="space-y-2 text-xs text-slate-600">
            {run.radius_output?.one_liner && <p className="text-slate-700">{run.radius_output.one_liner}</p>}
            {(run.radius_output?.capabilities || []).map((cap, i) => (
              <p key={i}>
                <span className="font-semibold text-slate-700">{cap.name}</span>
                {cap.description ? ` — ${cap.description}` : ""}
              </p>
            ))}
            <p className={(run.radius_output?.proof_points || []).length ? "" : "text-amber-700"}>
              proof points: {(run.radius_output?.proof_points || []).length || "none published — the prompts are told so explicitly"}
            </p>
            {run.radius_output?.url && (
              <a href={run.radius_output.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                {run.radius_output.url} ↗
              </a>
            )}
          </div>
        </Collapsible>
      </div>
    </Section>
  );
}

/* ── the email (per person) ───────────────────────────────────────────────── */

function EmailPanel({ run }) {
  const out = run.email_output || {};
  const contract = run.email_contract || {};

  return (
    <Section
      title="Email"
      subtitle="Written for this person, underneath the campaign above."
      right={
        <div className="flex items-center gap-1.5">
          <Pill tone={run.is_valid ? "green" : "amber"}>{run.is_valid ? "Passed all gates" : "Rejected"}</Pill>
          {run.tone && <Pill>{run.tone}</Pill>}
          <CopyButton text={`Subject: ${run.subject || ""}\n\n${run.body || ""}`} label="Copy email" />
        </div>
      }
    >
      <div className="space-y-4">
        <article className="overflow-hidden rounded-xl border border-slate-200">
          <div className="space-y-1 border-b border-slate-100 bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-500">
              To <span className="font-medium text-slate-700">{run.person_name || "—"}</span>
              {run.person_email ? ` <${run.person_email}>` : ""}
            </p>
            <p className="text-base font-semibold text-slate-900">{run.subject || "(no subject generated)"}</p>
          </div>
          <div className="whitespace-pre-wrap px-4 py-4 text-sm leading-relaxed text-slate-800">
            {run.body || "(no body generated)"}
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 bg-slate-50 px-4 py-2 text-[11px] text-slate-500">
            <span>{words(run.body)} words</span>
            {contract.max_words && <span>limit {contract.max_words}</span>}
            {run.coverage && <span>coverage {run.coverage}</span>}
            {run.provider && <span>{run.provider}{run.model ? ` · ${run.model}` : ""}</span>}
          </div>
        </article>

        {run.error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">Generation error: {run.error}</p>
        )}
        <Warnings items={run.warnings} />

        <div className="grid gap-4 sm:grid-cols-2">
          {out.hooks_used?.length > 0 && (
            <div>
              <p className={labelCls}>Hooks used</p>
              <ul className="space-y-1 text-xs text-slate-600">
                {out.hooks_used.map((h, i) => (
                  <li key={i}>• {h}</li>
                ))}
              </ul>
            </div>
          )}
          {out.facts_cited?.length > 0 && (
            <div>
              <p className={labelCls}>Facts cited</p>
              <ul className="space-y-1 text-xs text-slate-600">
                {out.facts_cited.map((f, i) => (
                  <li key={i}>• {typeof f === "string" ? f : f?.fact || JSON.stringify(f)}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div>
          <p className={labelCls}>Email gates</p>
          <Gates gates={run.validation} />
        </div>

        <Collapsible title={`Contract — the ${(contract.allowed_facts || []).length} fact(s) the model was allowed to know`}>
          <div className="space-y-2 text-xs text-slate-600">
            {contract.top_hooks?.length > 0 && (
              <p>
                <span className="font-semibold text-slate-700">Top hooks:</span> {contract.top_hooks.join(" · ")}
              </p>
            )}
            {contract.trigger_event && (
              <p>
                <span className="font-semibold text-slate-700">Trigger event:</span> {contract.trigger_event}
              </p>
            )}
            {contract.suggested_subject_angle && (
              <p>
                <span className="font-semibold text-slate-700">Suggested angle:</span> {contract.suggested_subject_angle}
              </p>
            )}
            {(contract.allowed_facts || []).map((f, i) => (
              <p key={i} className="border-l-2 border-slate-200 pl-2">
                {f.fact}
                {f.source_url && (
                  <a
                    href={f.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-1.5 text-blue-600 hover:underline"
                  >
                    source ↗
                  </a>
                )}
              </p>
            ))}
            {(contract.allowed_facts || []).length === 0 && (
              <p className="text-slate-400">
                Nothing cleared the confidence floor — the email is generic by design rather than specific by invention.
              </p>
            )}
          </div>
        </Collapsible>
      </div>
    </Section>
  );
}

/* ── the follow-up sequence ───────────────────────────────────────────────── */

function FollowupPanel({ run, followups, onChange, onError, onFlash }) {
  const [busy, setBusy] = useState("");

  async function generate(regenerate) {
    setBusy(regenerate ? "regenerate" : "generate");
    onError("");
    try {
      const res = await fetch("/api/followup-testing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email_testing_id: run.id, steps: [1, 2], regenerate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Follow-up generation failed");
      const ok = (data.followups || []).filter((f) => f.valid).length;
      onFlash(`${ok}/${(data.followups || []).length} follow-up step(s) passed every gate.`);
      onChange();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <Section
      title="Follow-ups"
      subtitle="Sent on no reply — never on “not opened”. Each step must earn its send."
      right={
        <div className="flex items-center gap-1.5">
          {followups.length > 0 && (
            <button className={btnGhostSm} onClick={() => generate(true)} disabled={Boolean(busy)}>
              {busy === "regenerate" ? "Regenerating…" : "↻ Regenerate"}
            </button>
          )}
          <button className={btnPrimary} onClick={() => generate(false)} disabled={Boolean(busy) || !run.subject}>
            {busy === "generate" ? "Generating…" : followups.length ? "Fill missing steps" : "Generate follow-ups"}
          </button>
        </div>
      }
    >
      {!run.subject ? (
        <p className="text-sm text-slate-400">
          This run produced no email, so there is nothing to follow up on.
        </p>
      ) : followups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center">
          <p className="text-sm text-slate-500">No follow-up steps yet.</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-400">
            Step 1 (+3 days) adds one new specific and makes the ask smaller. Step 2 (+7 days) is the shortest, final
            and easy to decline. Each step is written against the real text of every step before it.
          </p>
        </div>
      ) : (
        <ol className="space-y-4">
          <li className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Pill>Step 0 · day 0</Pill>
              <span className="text-xs text-slate-500">the original email</span>
            </div>
            <p className="mt-1.5 text-sm font-semibold text-slate-800">{run.subject}</p>
          </li>

          {followups.map((f) => (
            <li key={f.id || f.step_number} className="overflow-hidden rounded-lg border border-slate-200">
              <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-white px-4 py-2.5">
                <Pill tone="blue">Step {f.step_number} · +{f.send_after_days ?? "?"} days</Pill>
                <Pill tone={f.is_valid ? "green" : "amber"}>{f.is_valid ? "Draft" : "Rejected"}</Pill>
                <span className="text-[11px] text-slate-400">{words(f.body)} words</span>
                <span className="ml-auto">
                  <CopyButton text={`Subject: ${f.subject || ""}\n\n${f.body || ""}`} />
                </span>
              </div>

              {f.angle && (
                <p className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-500">
                  <span className="font-semibold text-slate-600">Angle:</span> {f.angle}
                </p>
              )}

              <div className="px-4 py-3">
                <p className="text-sm font-semibold text-slate-900">{f.subject || "(no subject)"}</p>
                <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
                  {f.body || "(no body)"}
                </div>
              </div>

              <div className="space-y-2 border-t border-slate-100 px-4 py-3">
                {f.error && <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{f.error}</p>}
                <Warnings items={f.warnings} />
                <Gates gates={f.validation} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

/* ── research + prompts (the receipts) ────────────────────────────────────── */

function ResearchPanel({ run }) {
  const r = run.research_output || {};
  const syn = r.synthesis || {};
  const meta = r.meta || {};
  const hookSources = meta.hook_sources || [];

  return (
    <Section
      title="Research"
      subtitle="What we found out about them, and where."
      right={
        <div className="flex items-center gap-1.5">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${COVERAGE_PILL[meta.coverage] || COVERAGE_PILL.thin}`}>
            coverage {meta.coverage || "—"}
          </span>
          <Pill>{(meta.sources_checked || []).length || 0} sources</Pill>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className={labelCls}>Person</p>
            <p className="text-sm font-medium text-slate-800">{r.person?.full_name || run.person_name}</p>
            <p className="text-xs text-slate-500">
              {[r.person?.current_title, r.person?.university || r.person?.current_org].filter(Boolean).join(" · ") || "—"}
            </p>
          </div>
          <div>
            <p className={labelCls}>Organisation</p>
            <p className="text-sm font-medium text-slate-800">{r.university?.name || run.org_name || "—"}</p>
            <p className="text-xs text-slate-500">
              {[r.university?.type, r.university?.location].filter(Boolean).join(" · ") || "—"}
            </p>
          </div>
        </div>

        <div>
          <p className={labelCls}>Top hooks (max 3, above the citation floor)</p>
          {hookSources.length > 0 ? (
            <ul className="space-y-1.5">
              {hookSources.map((h, i) => (
                <li key={i} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">
                  <p className="text-slate-700">{h.text}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                    <span>{h.scope}</span>
                    <span>confidence {h.confidence}</span>
                    {h.snippet_only && <Pill tone="amber">snippet only</Pill>}
                    {h.source_url && (
                      <a href={h.source_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                        {h.source_url.replace(/^https?:\/\//, "").slice(0, 48)} ↗
                      </a>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          ) : syn.top_hooks?.length ? (
            <ul className="space-y-1 text-xs text-slate-600">
              {syn.top_hooks.map((h, i) => (
                <li key={i}>• {h}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-400">No hook cleared the floor — this is the thin-coverage path.</p>
          )}
        </div>

        {(syn.trigger_event || syn.shared_context) && (
          <div className="grid gap-3 sm:grid-cols-2 text-xs text-slate-600">
            {syn.trigger_event && (
              <p>
                <span className={labelCls}>Trigger event</span>
                {syn.trigger_event}
              </p>
            )}
            {syn.shared_context && (
              <p>
                <span className={labelCls}>Shared context</span>
                {syn.shared_context}
              </p>
            )}
          </div>
        )}

        {meta.sources_checked?.length > 0 && (
          <Collapsible title={`Sources checked (${meta.sources_checked.length})`}>
            <ul className="space-y-1 text-xs">
              {meta.sources_checked.map((s, i) => (
                <li key={i}>
                  <a
                    href={typeof s === "string" ? s : s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    {typeof s === "string" ? s : s.url}
                  </a>
                </li>
              ))}
            </ul>
          </Collapsible>
        )}
      </div>
    </Section>
  );
}

function PromptsPanel({ runId }) {
  const [prompts, setPrompts] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/email-testing/${runId}?prompts=1`);
      const data = await res.json();
      if (res.ok) setPrompts(data.run);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  const block = (title, text) => (
    <div>
      <p className={labelCls}>{title}</p>
      <pre className="max-h-72 overflow-auto rounded-lg bg-slate-900 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100">
        {text || "—"}
      </pre>
    </div>
  );

  return (
    <Section title="Prompts" subtitle="Exactly what was sent to the model, for both calls.">
      <Collapsible title="Show prompts" onOpen={load}>
        {loading && <p className="text-xs text-slate-500">Loading…</p>}
        {prompts && (
          <div className="space-y-3">
            {block("Campaign — system", prompts.campaign_prompt_system)}
            {block("Campaign — user", prompts.campaign_prompt_user)}
            {block("Email — system", prompts.email_prompt_system)}
            {block("Email — user", prompts.email_prompt_user)}
          </div>
        )}
      </Collapsible>
    </Section>
  );
}

/* ── one run, whole chain ─────────────────────────────────────────────────── */

function RunDetail({ runId, onError, onFlash, onDeleted }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/email-testing/${runId}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load run");
      setData(json);
    } catch (e) {
      onError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [runId, onError]);

  useEffect(() => {
    load();
  }, [load]);

  async function remove() {
    if (!confirm(`Delete run #${runId} and its follow-up steps? Nothing was sent, so this only discards drafts.`)) return;
    try {
      const res = await fetch(`/api/email-testing/${runId}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Delete failed");
      onFlash(`Run #${runId} deleted.`);
      onDeleted();
    } catch (e) {
      onError(e.message);
    }
  }

  if (loading) return <p className="text-sm text-slate-500">Loading run #{runId}…</p>;
  if (!data) return null;

  const { run, followups } = data;

  return (
    <div className="space-y-4">
      <div className={`${sectionCard} px-5 py-4`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="mr-auto">
            <h2 className="text-base font-bold text-slate-900">
              {run.person_name}
              {run.org_name ? <span className="font-normal text-slate-400"> @ {run.org_name}</span> : null}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Run #{run.id} · {when(run.created_at)}
              {run.run_label ? <> · <span className={codeCls}>{run.run_label}</span></> : null}
              {run.person_email ? ` · ${run.person_email}` : ""}
            </p>
          </div>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              STATUS_PILL[run.status] || STATUS_PILL.draft
            }`}
          >
            {run.status}
          </span>
          {run.mode === "on_behalf" && <Pill tone="blue">on behalf</Pill>}
          <button className={btnGhostSm} onClick={load} title="Reload">
            ↻
          </button>
          <button className={btnGhostSm} onClick={remove} title="Delete this run">
            🗑
          </button>
        </div>

        {/* The chain, in order, so it is obvious which stage a bad email came from. */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
          {[
            ["1 Research", run.coverage ? `coverage ${run.coverage}` : "done", "blue"],
            ["2 Product", run.radius_output?.name || "RadiusAI", "slate"],
            ["3 Campaign", run.campaign_cached ? "cached" : "generated", "slate"],
            ["4 Email", run.is_valid ? "passed" : "rejected", run.is_valid ? "green" : "amber"],
          ].map(([label, detail, tone], i) => (
            <span key={label} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-slate-300">→</span>}
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1">
                <span className="font-semibold text-slate-700">{label}</span>
                <Pill tone={tone}>{detail}</Pill>
              </span>
            </span>
          ))}
        </div>
      </div>

      <CampaignPanel run={run} />
      <EmailPanel run={run} />
      <FollowupPanel run={run} followups={followups} onChange={load} onError={onError} onFlash={onFlash} />
      <ResearchPanel run={run} />
      <PromptsPanel runId={run.id} />
    </div>
  );
}

/* ── history ──────────────────────────────────────────────────────────────── */

function History({ runs, loading, selectedId, onSelect }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return runs.filter((r) => {
      if (filter === "valid" && !r.is_valid) return false;
      if (filter === "rejected" && r.is_valid) return false;
      if (!needle) return true;
      return [r.person_name, r.org_name, r.subject, r.campaign_line, r.run_label]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(needle));
    });
  }, [runs, q, filter]);

  useEffect(() => {
    setPage(1);
  }, [q, filter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const chip = (key, label) => (
    <button
      key={key}
      onClick={() => setFilter(key)}
      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
        filter === key ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
      }`}
    >
      {label}
    </button>
  );

  return (
    <section className={sectionCard}>
      <div className={sectionHead}>
        <h2 className="mr-auto text-sm font-bold text-slate-900">Generated runs</h2>
        <div className="flex items-center gap-1.5">
          {chip("all", "All")}
          {chip("valid", "Passed")}
          {chip("rejected", "Rejected")}
        </div>
        <input
          className={`${inputCls} w-44`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search person, org, subject…"
        />
      </div>

      {loading ? (
        <p className="px-5 py-6 text-sm text-slate-500">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-slate-400">
          {runs.length === 0 ? "No runs yet — generate one on the left." : "Nothing matches that filter."}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 bg-slate-50">
                <tr>
                  {["#", "Person", "Organisation", "Campaign line", "Subject", "Follow-ups", "Status", "When"].map((h) => (
                    <th key={h} className={thCls}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => onSelect(r.id)}
                    className={`cursor-pointer transition ${
                      r.id === selectedId ? "bg-blue-50" : "hover:bg-slate-50"
                    }`}
                  >
                    <td className={`${tdCls} text-xs text-slate-400`}>{r.id}</td>
                    <td className={`${tdCls} font-medium text-slate-800`}>{r.person_name || "—"}</td>
                    <td className={`${tdCls} text-slate-600`}>{r.org_name || "—"}</td>
                    <td className={`${tdCls} text-slate-600`}>{r.campaign_line || "—"}</td>
                    <td className="px-3 py-2.5 align-middle text-slate-700" title={r.subject || ""}>
                      <span className="block max-w-[18rem] truncate">{r.subject || "—"}</span>
                    </td>
                    <td className={tdCls}>
                      {r.followup_count > 0 ? <Pill tone="blue">{r.followup_count}</Pill> : <span className="text-slate-300">—</span>}
                    </td>
                    <td className={tdCls}>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          STATUS_PILL[r.status] || STATUS_PILL.draft
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className={`${tdCls} text-xs text-slate-500`}>{when(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageCount={pageCount}
            total={filtered.length}
            pageSize={PAGE_SIZE}
            onChange={setPage}
            label="runs"
          />
        </>
      )}
    </section>
  );
}

/* ── page ─────────────────────────────────────────────────────────────────── */

export default function GenerationPage() {
  const [runs, setRuns] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadRuns = useCallback(async (selectFirst = false) => {
    setLoading(true);
    try {
      const res = await fetch("/api/email-testing?limit=200");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load runs");
      setRuns(data.runs || []);
      if (selectFirst && data.runs?.length) setSelectedId((id) => id ?? data.runs[0].id);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // ?run=<id> opens one run directly — that is the link Preview uses from the
    // Recipients table. Read from the URL rather than useSearchParams so the
    // page still prerenders without a Suspense boundary.
    const wanted = Number(new URLSearchParams(window.location.search).get("run"));
    if (Number.isInteger(wanted) && wanted > 0) setSelectedId(wanted);
    loadRuns(!wanted);
  }, [loadRuns]);

  const flash = useCallback((msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(""), 5000);
  }, []);

  function onRan(id) {
    loadRuns();
    if (id) setSelectedId(id);
  }

  return (
    <div className="min-h-screen">
      <AppHeader
        active="generation"
        subtitle="Campaign, email and follow-ups — generated, never sent."
        width="max-w-7xl"
        actions={
          <button className={btnGhostSm} onClick={() => loadRuns()} title="Refresh">
            ↻ Refresh
          </button>
        }
      />

      <main className="mx-auto max-w-7xl space-y-4 px-5 py-6">
        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
        {notice && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {notice}
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(320px,380px)_1fr] lg:items-start">
          <RunForm onRan={onRan} onError={setError} onFlash={flash} />

          <div className="space-y-4">
            {selectedId ? (
              <RunDetail
                key={selectedId}
                runId={selectedId}
                onError={setError}
                onFlash={flash}
                onDeleted={() => {
                  setSelectedId(null);
                  loadRuns();
                }}
              />
            ) : (
              <div className={`${sectionCard} px-6 py-10 text-center`}>
                <p className="text-sm font-medium text-slate-700">Nothing selected</p>
                <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                  Generate a run on the left, or pick one from the history below to read its campaign, its email and
                  its follow-up sequence.
                </p>
              </div>
            )}

            <History runs={runs} loading={loading} selectedId={selectedId} onSelect={setSelectedId} />
          </div>
        </div>
      </main>
    </div>
  );
}
