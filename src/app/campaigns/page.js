"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import AppHeader from "@/components/AppHeader";
import {
  btnPrimary,
  btnGhost,
  btnGhostSm,
  inputCls,
  labelCls,
} from "@/lib/ui";

// Campaign control room: build a sequence (initial + follow-up steps), create a
// campaign that targets a slice of contacts on that sequence, enroll them, and
// start/pause the engine. The worker (npm run worker) does the actual sending.

const STATUS_STYLE = {
  draft: "bg-slate-100 text-slate-600 ring-slate-200",
  active: "bg-emerald-100 text-emerald-700 ring-emerald-200",
  paused: "bg-amber-100 text-amber-700 ring-amber-200",
  done: "bg-slate-200 text-slate-500 ring-slate-300",
};

// Per-enrollment-status chip colours in a campaign card.
const ENROLL_CHIP = {
  active: "bg-emerald-50 text-emerald-700",
  replied: "bg-blue-50 text-blue-700",
  completed: "bg-slate-100 text-slate-500",
  unsubscribed: "bg-amber-50 text-amber-700",
  bounced: "bg-red-50 text-red-700",
  paused: "bg-amber-50 text-amber-700",
};

export default function CampaignsPage() {
  const [sequences, setSequences] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadAll() {
    setLoading(true);
    try {
      const [tRes, sRes, cRes] = await Promise.all([
        fetch("/api/templates"),
        fetch("/api/sequences"),
        fetch("/api/campaigns"),
      ]);
      const [t, s, c] = await Promise.all([tRes.json(), sRes.json(), cRes.json()]);
      if (!tRes.ok) throw new Error(t.error || "Failed to load templates");
      if (!sRes.ok) throw new Error(s.error || "Failed to load sequences");
      if (!cRes.ok) throw new Error(c.error || "Failed to load campaigns");
      setTemplates(t.templates || []);
      setSequences(s.sequences || []);
      setCampaigns(c.campaigns || []);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  function flash(msg) {
    setNotice(msg);
    setTimeout(() => setNotice(""), 4000);
  }

  const stats = useMemo(() => {
    const active = campaigns.filter((c) => c.status === "active").length;
    const enrolled = campaigns.reduce((n, c) => n + (c.enrollment_total || 0), 0);
    const activeEnroll = campaigns.reduce((n, c) => n + (c.enrollment_counts?.active || 0), 0);
    const sentToday = campaigns.reduce((n, c) => n + (c.sent_today || 0), 0);
    return { campaigns: campaigns.length, active, enrolled, activeEnroll, sentToday };
  }, [campaigns]);

  return (
    <div className="min-h-screen">
      <AppHeader
        active="campaigns"
        subtitle="Automated cold-email sequences with follow-ups."
        actions={
          <button className={btnGhostSm} onClick={loadAll} title="Refresh">
            ↻ Refresh
          </button>
        }
      />

      <main className="mx-auto max-w-6xl space-y-6 px-5 py-6">
        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {notice}
          </p>
        )}

        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <>
            <Overview stats={stats} workerHint={stats.active > 0} />

            {sequences.length === 0 && campaigns.length === 0 && (
              <GettingStarted hasTemplates={templates.length > 0} />
            )}

            <AIComposer onChange={loadAll} onError={setError} onFlash={flash} />

            <CampaignList
              campaigns={campaigns}
              onChange={loadAll}
              onError={setError}
              onFlash={flash}
            />
            <CampaignBuilder
              sequences={sequences}
              onChange={loadAll}
              onError={setError}
              onFlash={flash}
            />
            <SequenceBuilder
              templates={templates}
              sequences={sequences}
              onChange={loadAll}
              onError={setError}
              onFlash={flash}
            />
          </>
        )}
      </main>
    </div>
  );
}

// ---- Overview strip -------------------------------------------------------

function Overview({ stats, workerHint }) {
  const tiles = [
    { label: "Campaigns", value: stats.campaigns, sub: `${stats.active} active` },
    { label: "Enrolled contacts", value: stats.enrolled, sub: `${stats.activeEnroll} still sending` },
    { label: "Sent today", value: stats.sentToday, sub: "across all campaigns" },
  ];
  return (
    <section className="grid gap-3 sm:grid-cols-3">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {t.label}
          </div>
          <div className="mt-1 text-2xl font-bold text-slate-900">{t.value}</div>
          <div className="mt-0.5 text-xs text-slate-500">{t.sub}</div>
        </div>
      ))}
      {workerHint && (
        <div className="sm:col-span-3">
          <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
            You have active campaigns. Make sure the worker is running so they actually send:{" "}
            <code className="rounded bg-white/70 px-1 py-0.5 font-mono">npm run worker</code>
          </p>
        </div>
      )}
    </section>
  );
}

// ---- Getting started ------------------------------------------------------

function GettingStarted({ hasTemplates }) {
  const steps = [
    { n: 1, t: "Create templates", d: hasTemplates ? "Done — you have templates." : "On the Recipients page. Use {{first_name}} etc.", ok: hasTemplates },
    { n: 2, t: "Build a sequence", d: "Below: an initial email + timed follow-ups." },
    { n: 3, t: "Create a campaign", d: "Target contacts, set a low daily cap + send window." },
    { n: 4, t: "Enroll + Start", d: "Then run npm run worker — it sends on schedule." },
  ];
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">Get started</h2>
      <ol className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s) => (
          <li key={s.n} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
            <div className="flex items-center gap-2">
              <span
                className={
                  "grid h-6 w-6 place-items-center rounded-full text-xs font-bold text-white " +
                  (s.ok ? "bg-emerald-500" : "bg-blue-600")
                }
              >
                {s.ok ? "✓" : s.n}
              </span>
              <span className="text-sm font-semibold text-slate-800">{s.t}</span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{s.d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---- AI Composer ----------------------------------------------------------
// Generate a per-segment email sequence with Claude, review/edit the drafts,
// then approve → it creates one template per step + a sequence (+ optionally a
// campaign targeting that title). Your pitch/tone are remembered locally.

const AI_PROFILE_KEY = "brevoAIProfile.v1";
const DEFAULT_DELAY = (i) => (i === 0 ? 0 : i === 1 ? 48 : 72);

function AIComposer({ onChange, onError, onFlash }) {
  const [open, setOpen] = useState(false);
  const [pitch, setPitch] = useState("");
  const [senderName, setSenderName] = useState("");
  const [tone, setTone] = useState("warm, concise");
  const [segment, setSegment] = useState("");
  const [stepCount, setStepCount] = useState(3);
  const [drafts, setDrafts] = useState([]); // [{subject, body, delay_hours}]
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [alsoCampaign, setAlsoCampaign] = useState(true);
  const hydrated = useRef(false);

  // Remember pitch/sender/tone across visits (device-local, like the composer draft).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(AI_PROFILE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p.pitch) setPitch(p.pitch);
        if (p.senderName) setSenderName(p.senderName);
        if (p.tone) setTone(p.tone);
      }
    } catch {
      /* ignore */
    }
    hydrated.current = true;
  }, []);
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(AI_PROFILE_KEY, JSON.stringify({ pitch, senderName, tone }));
    } catch {
      /* non-fatal */
    }
  }, [pitch, senderName, tone]);

  const setDraft = (i, patch) =>
    setDrafts((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));

  async function generate() {
    if (!pitch.trim()) return onError("Add your product pitch first.");
    setGenerating(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productPitch: pitch,
          targetDescription: segment,
          tone,
          steps: Number(stepCount) || 3,
          senderName,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      setDrafts((data.steps || []).map((s, i) => ({ ...s, delay_hours: DEFAULT_DELAY(i) })));
      onFlash("Draft generated — review and edit below, then approve.");
    } catch (e) {
      onError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  async function approve() {
    if (drafts.length === 0) return;
    const segLabel = segment.trim() || "General";
    const stamp = new Date().toISOString().slice(0, 10);
    setApproving(true);
    try {
      // 1. One template per step.
      const templateIds = [];
      for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i];
        const res = await fetch("/api/templates", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `AI · ${segLabel} · Step ${i + 1} (${stamp})`,
            subject: d.subject,
            body: d.body,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Saving a template failed");
        templateIds.push(data.template.id);
      }

      // 2. The sequence referencing them.
      const seqRes = await fetch("/api/sequences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `AI · ${segLabel} (${stamp})`,
          steps: drafts.map((d, i) => ({
            template_id: templateIds[i],
            delay_hours: Number(d.delay_hours) || 0,
          })),
        }),
      });
      const seqData = await seqRes.json();
      if (!seqRes.ok) throw new Error(seqData.error || "Creating the sequence failed");

      // 3. Optionally a draft campaign targeting this title.
      if (alsoCampaign && segment.trim()) {
        const campRes = await fetch("/api/campaigns", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `${segLabel} outreach`,
            sequence_id: seqData.sequence.id,
            target_filter: { title_ilike: segment.trim() },
            daily_cap: 30,
            window_start: 9,
            window_end: 18,
            timezone: "Asia/Kolkata",
          }),
        });
        const campData = await campRes.json();
        if (!campRes.ok) throw new Error(campData.error || "Creating the campaign failed");
        onFlash(`Created sequence + draft campaign "${segLabel} outreach". Enroll + Start it below.`);
      } else {
        onFlash(`Created sequence "AI · ${segLabel}". Attach it to a campaign below.`);
      }

      setDrafts([]);
      onChange();
    } catch (e) {
      onError(e.message);
    } finally {
      setApproving(false);
    }
  }

  return (
    <section className="rounded-xl border border-violet-200 bg-gradient-to-b from-violet-50/60 to-white shadow-sm">
      <button
        className="flex w-full items-center justify-between px-5 py-4 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span>✨</span> Generate emails with AI
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Draft a per-role sequence with Claude, review it, and turn it into a sequence + campaign — no manual copywriting.
          </p>
        </div>
        <span className="text-lg text-violet-400">{open ? "×" : "＋"}</span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-violet-100 p-5">
          <div>
            <label className={labelCls}>What you sell (product pitch)</label>
            <textarea
              className={`${inputCls} min-h-[80px] resize-y`}
              placeholder="e.g. RadiusAI builds an AI resume + placement platform that helps university placement cells get students job-ready faster…"
              value={pitch}
              onChange={(e) => setPitch(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-slate-400">Remembered on this device. The AI writes only from this — keep it accurate.</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className={labelCls}>Target title / segment</label>
              <input className={inputCls} placeholder="e.g. placement officer" value={segment} onChange={(e) => setSegment(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>From (name)</label>
              <input className={inputCls} value={senderName} onChange={(e) => setSenderName(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Tone</label>
              <input className={inputCls} value={tone} onChange={(e) => setTone(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Steps</label>
              <input type="number" min="1" max="5" className={inputCls} value={stepCount} onChange={(e) => setStepCount(e.target.value)} />
            </div>
          </div>

          <button className={btnPrimary} onClick={generate} disabled={generating}>
            {generating ? "Generating…" : "✨ Generate draft"}
          </button>

          {drafts.length > 0 && (
            <div className="space-y-3 border-t border-violet-100 pt-4">
              <p className="text-xs font-semibold text-slate-600">
                Review &amp; edit — nothing is saved until you approve.
              </p>
              {drafts.map((d, i) => (
                <div key={i} className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="grid h-5 w-5 place-items-center rounded-full bg-violet-600 text-[10px] font-bold text-white">
                      {i + 1}
                    </span>
                    <span className="text-xs font-semibold text-slate-500">
                      {i === 0 ? "Initial email" : `Follow-up ${i}`}
                    </span>
                    <span className="ml-auto flex items-center gap-1 text-[11px] text-slate-400">
                      {i === 0 ? "sends immediately" : "wait"}
                      {i > 0 && (
                        <input
                          type="number"
                          min="0"
                          className="w-16 rounded border border-slate-300 px-1.5 py-0.5 text-center text-xs"
                          value={d.delay_hours}
                          onChange={(e) => setDraft(i, { delay_hours: e.target.value })}
                        />
                      )}
                      {i > 0 && "h after prev"}
                    </span>
                  </div>
                  <input
                    className={`${inputCls} mb-2 font-medium`}
                    value={d.subject}
                    onChange={(e) => setDraft(i, { subject: e.target.value })}
                  />
                  <textarea
                    className={`${inputCls} min-h-[110px] resize-y leading-relaxed`}
                    value={d.body}
                    onChange={(e) => setDraft(i, { body: e.target.value })}
                  />
                </div>
              ))}

              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input type="checkbox" checked={alsoCampaign} onChange={(e) => setAlsoCampaign(e.target.checked)} />
                Also create a draft campaign targeting title ~ &quot;{segment.trim() || "…"}&quot;
                {!segment.trim() && <span className="text-amber-600">(add a segment to enable)</span>}
              </label>

              <div className="flex items-center gap-2">
                <button className={btnPrimary} onClick={approve} disabled={approving}>
                  {approving ? "Saving…" : "✓ Approve & create"}
                </button>
                <button className={btnGhost} onClick={() => setDrafts([])} disabled={approving}>
                  Discard
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---- Campaign list --------------------------------------------------------

function CampaignList({ campaigns, onChange, onError, onFlash }) {
  const [busyId, setBusyId] = useState(null);

  async function act(id, body) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/campaigns/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Update failed");
      onChange();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  async function enroll(c) {
    setBusyId(c.id);
    try {
      const pRes = await fetch(`/api/campaigns/${c.id}/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preview: true }),
      });
      const preview = await pRes.json();
      if (!pRes.ok) throw new Error(preview.error || "Enroll preview failed");
      if (preview.would_enroll === 0) {
        onFlash(`Nothing to enroll: ${preview.matched} match, all already enrolled.`);
        return;
      }
      if (
        !confirm(
          `Enroll ${preview.would_enroll} new contact(s) into "${c.name}"? ` +
            `(${preview.matched} match the filter, ${preview.already_enrolled} already enrolled.)`
        )
      ) {
        return;
      }
      const res = await fetch(`/api/campaigns/${c.id}/enroll`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Enroll failed");
      onFlash(`Enrolled ${data.enrolled} contact(s) into "${c.name}".`);
      onChange();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(c) {
    if (!confirm(`Delete campaign "${c.name}" and all its enrollments? This cannot be undone.`)) return;
    setBusyId(c.id);
    try {
      const res = await fetch(`/api/campaigns/${c.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Delete failed");
      onFlash(`Deleted "${c.name}".`);
      onChange();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  if (campaigns.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="px-1 text-sm font-semibold text-slate-900">
        Your campaigns <span className="text-slate-400">({campaigns.length})</span>
      </h2>
      <div className="grid gap-3 lg:grid-cols-2">
        {campaigns.map((c) => {
          const busy = busyId === c.id;
          const counts = c.enrollment_counts || {};
          const capPct = c.daily_cap ? Math.min(100, Math.round((c.sent_today / c.daily_cap) * 100)) : 0;
          const filterKeys = Object.keys(c.target_filter || {});
          return (
            <div key={c.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-semibold text-slate-900">{c.name}</h3>
                    <span
                      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${STATUS_STYLE[c.status] || "bg-slate-100"}`}
                    >
                      {c.status}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {c.sequence_name} · {c.window_start}:00–{c.window_end}:00 {c.timezone}
                  </p>
                </div>
                <button
                  className="shrink-0 rounded-md p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => remove(c)}
                  title="Delete campaign"
                  aria-label="Delete campaign"
                >
                  🗑
                </button>
              </div>

              {/* Daily cap meter */}
              <div className="mt-3">
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>Sent today</span>
                  <span className="font-semibold text-slate-700">
                    {c.sent_today} / {c.daily_cap}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={"h-full rounded-full " + (capPct >= 100 ? "bg-amber-500" : "bg-blue-500")}
                    style={{ width: `${capPct}%` }}
                  />
                </div>
              </div>

              {/* Enrollment breakdown */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-slate-400">
                  {c.enrollment_total} enrolled:
                </span>
                {Object.entries(counts).length === 0 && (
                  <span className="text-[11px] text-slate-400">none yet</span>
                )}
                {Object.entries(counts).map(([status, n]) => (
                  <span
                    key={status}
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${ENROLL_CHIP[status] || "bg-slate-100 text-slate-500"}`}
                  >
                    {n} {status}
                  </span>
                ))}
              </div>

              {filterKeys.length > 0 && (
                <p className="mt-2 truncate text-[11px] text-slate-400" title={JSON.stringify(c.target_filter)}>
                  filter: {filterKeys.map((k) => `${k.replace("_ilike", "")}~"${c.target_filter[k]}"`).join(", ")}
                </p>
              )}

              {/* Actions */}
              <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
                <button className={btnGhostSm} disabled={busy} onClick={() => enroll(c)}>
                  ＋ Enroll
                </button>
                {c.status === "active" ? (
                  <button className={btnGhostSm} disabled={busy} onClick={() => act(c.id, { status: "paused" })}>
                    ⏸ Pause
                  </button>
                ) : (
                  <button
                    className={`${btnGhostSm} border-emerald-300 text-emerald-700 hover:bg-emerald-50`}
                    disabled={busy}
                    onClick={() => act(c.id, { status: "active" })}
                  >
                    ▶ Start
                  </button>
                )}
                {busy && <span className="text-xs text-slate-400">…</span>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---- Campaign builder (collapsible) --------------------------------------

function CampaignBuilder({ sequences, onChange, onError, onFlash }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    sequence_id: "",
    title_ilike: "",
    company_ilike: "",
    industry_ilike: "",
    daily_cap: 30,
    window_start: 9,
    window_end: 18,
    timezone: "Asia/Kolkata",
  });
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  function buildFilter() {
    const filter = {};
    for (const k of ["title_ilike", "company_ilike", "industry_ilike"]) {
      if (form[k].trim()) filter[k] = form[k].trim();
    }
    return filter;
  }

  async function save() {
    if (!form.name.trim()) return onError("Give the campaign a name.");
    if (!form.sequence_id) return onError("Pick a sequence.");
    setSaving(true);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          sequence_id: Number(form.sequence_id),
          target_filter: buildFilter(),
          daily_cap: Number(form.daily_cap) || 30,
          window_start: Number(form.window_start),
          window_end: Number(form.window_end),
          timezone: form.timezone.trim() || "Asia/Kolkata",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create campaign");
      set({ name: "", title_ilike: "", company_ilike: "", industry_ilike: "" });
      setOpen(false);
      onFlash(`Campaign "${data.campaign.name}" created as draft. Enroll contacts, then start it.`);
      onChange();
    } catch (e) {
      onError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <button
        className="flex w-full items-center justify-between px-5 py-4 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <div>
          <h2 className="text-sm font-semibold text-slate-900">New campaign</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Target contacts by an ILIKE filter, set warm-up cap + send window.
          </p>
        </div>
        <span className="text-lg text-slate-400">{open ? "×" : "＋"}</span>
      </button>

      {open && (
        <div className="border-t border-slate-100 p-5">
          {sequences.length === 0 ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Create a sequence first (below) — a campaign needs one to send.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className={labelCls}>Campaign name</label>
                <input className={inputCls} value={form.name} onChange={(e) => set({ name: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Sequence</label>
                <select className={inputCls} value={form.sequence_id} onChange={(e) => set({ sequence_id: e.target.value })}>
                  <option value="">Select…</option>
                  {sequences.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.steps.length} step{s.steps.length === 1 ? "" : "s"})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>Timezone</label>
                <input className={inputCls} value={form.timezone} onChange={(e) => set({ timezone: e.target.value })} />
              </div>

              <div>
                <label className={labelCls}>Title contains</label>
                <input className={inputCls} placeholder="e.g. placement" value={form.title_ilike} onChange={(e) => set({ title_ilike: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Company contains</label>
                <input className={inputCls} value={form.company_ilike} onChange={(e) => set({ company_ilike: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Industry contains</label>
                <input className={inputCls} value={form.industry_ilike} onChange={(e) => set({ industry_ilike: e.target.value })} />
              </div>

              <div>
                <label className={labelCls}>Daily cap (start low!)</label>
                <input type="number" min="1" className={inputCls} value={form.daily_cap} onChange={(e) => set({ daily_cap: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Window start</label>
                  <input type="number" min="0" max="23" className={inputCls} value={form.window_start} onChange={(e) => set({ window_start: e.target.value })} />
                </div>
                <div>
                  <label className={labelCls}>Window end</label>
                  <input type="number" min="1" max="24" className={inputCls} value={form.window_end} onChange={(e) => set({ window_end: e.target.value })} />
                </div>
              </div>
              <div className="flex items-end">
                <button className={btnPrimary} onClick={save} disabled={saving}>
                  {saving ? "Creating…" : "Create campaign"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---- Sequence builder -----------------------------------------------------

function SequenceBuilder({ templates, sequences, onChange, onError, onFlash }) {
  const [name, setName] = useState("");
  const [steps, setSteps] = useState([{ template_id: "", delay_hours: 0 }]);
  const [saving, setSaving] = useState(false);

  const setStep = (i, patch) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const addStep = () => setSteps((prev) => [...prev, { template_id: "", delay_hours: 48 }]);
  const removeStep = (i) => setSteps((prev) => prev.filter((_, idx) => idx !== i));

  async function save() {
    if (!name.trim()) return onError("Give the sequence a name.");
    if (steps.some((s) => !s.template_id)) return onError("Every step needs a template.");
    setSaving(true);
    try {
      const res = await fetch("/api/sequences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          steps: steps.map((s) => ({
            template_id: Number(s.template_id),
            delay_hours: Number(s.delay_hours) || 0,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save sequence");
      setName("");
      setSteps([{ template_id: "", delay_hours: 0 }]);
      onFlash(`Sequence "${data.sequence.name}" saved.`);
      onChange();
    } catch (e) {
      onError(e.message);
    } finally {
      setSaving(false);
    }
  }

  const templateName = (id) => templates.find((t) => String(t.id) === String(id))?.name;

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-slate-900">Sequences</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          An ordered list of steps. Step 1 sends on enrollment; each later step waits its delay after the previous.
        </p>
      </div>

      <div className="space-y-4 p-5">
        {templates.length === 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            No templates yet. Create templates on the Recipients page first — steps reference them.
          </p>
        )}

        {/* Existing sequences, as a visual timeline */}
        {sequences.length > 0 && (
          <div className="space-y-2">
            {sequences.map((s) => (
              <div key={s.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-sm font-semibold text-slate-800">{s.name}</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {s.steps.map((st, idx) => (
                    <span key={st.id} className="flex items-center gap-1.5">
                      {idx > 0 && (
                        <span className="text-[11px] font-medium text-slate-400">
                          → +{st.delay_hours}h →
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600">
                        <span className="grid h-4 w-4 place-items-center rounded-full bg-blue-600 text-[9px] font-bold text-white">
                          {st.step_number}
                        </span>
                        {st.template_name || "—"}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* New sequence form */}
        <div className="rounded-lg border border-dashed border-slate-300 p-4">
          <div className="mb-3 max-w-sm">
            <label className={labelCls}>New sequence name</label>
            <input
              className={inputCls}
              placeholder="e.g. Placement outreach"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            {steps.map((s, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <div className="grid h-9 w-8 place-items-center rounded-full bg-blue-600 text-xs font-bold text-white">
                  {i + 1}
                </div>
                <div className="min-w-[200px] flex-1">
                  <label className={labelCls}>Template</label>
                  <select
                    className={inputCls}
                    value={s.template_id}
                    onChange={(e) => setStep(i, { template_id: e.target.value })}
                  >
                    <option value="">Select a template…</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="w-40">
                  <label className={labelCls}>
                    {i === 0 ? "Send after (hours)" : "Wait after prev (hours)"}
                  </label>
                  <input
                    type="number"
                    min="0"
                    className={inputCls}
                    value={s.delay_hours}
                    onChange={(e) => setStep(i, { delay_hours: e.target.value })}
                  />
                </div>
                <button
                  className={`${btnGhostSm} mb-0.5`}
                  onClick={() => removeStep(i)}
                  disabled={steps.length === 1}
                  title="Remove step"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {/* Live preview of the sequence being built */}
          {steps.some((s) => s.template_id) && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded-md bg-slate-50 p-2">
              <span className="text-[11px] text-slate-400">Preview:</span>
              {steps.map((s, i) => (
                <span key={i} className="flex items-center gap-1.5">
                  {i > 0 && <span className="text-[11px] text-slate-400">→ +{s.delay_hours || 0}h →</span>}
                  <span className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600">
                    {templateName(s.template_id) || `step ${i + 1}`}
                  </span>
                </span>
              ))}
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            <button className={btnGhost} onClick={addStep}>
              ＋ Add step
            </button>
            <button className={btnPrimary} onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save sequence"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
