"use client";

// Recipients — the contact list, and the three things you do to a contact:
//
//   Generate  → research + campaign + email for THIS person (30–90s, one row in
//               email_testing, visible on the Generation tab)
//   Follow-up → the 2-step sequence written against that email
//   Send      → sends what was already generated. Sending never generates: the
//               email that goes out is the one that was read in Preview.
//
// A contact with no generated email still sends the fixed draft from Set email,
// personalised with tokens — that is the manual path, unchanged.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Pagination from "@/components/Pagination";
import AppHeader from "@/components/AppHeader";
import { htmlFromBody } from "@/lib/htmlBody";
import {
  btnPrimary,
  btnGhost,
  btnGhostSm,
  inputCls,
  labelCls,
  codeCls,
  pillSent,
  pillFailed,
  thCls,
} from "@/lib/ui";

const DRAFT_KEY = "brevoEmailDraft.v1";
const DEMO_KEY = "brevoDemoRecipient.v1";
// Written by the Generation tab's form. Row-level Generate reuses the intent
// set there rather than asking for it again on every row.
const GEN_FORM_KEY = "radiusGenerationForm.v1";
const PAGE_SIZE = 10;

export default function Home() {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const [templates, setTemplates] = useState([]);
  const [activeTemplateId, setActiveTemplateId] = useState("");

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [rangeCount, setRangeCount] = useState(0);
  const [page, setPage] = useState(1);

  const [composerOpen, setComposerOpen] = useState(false);

  // What has already been generated, keyed by lower(email). Filled from the
  // server for the visible page, so a row generated last week (or from the
  // Generation tab) still opens in Preview instead of offering Generate again.
  const [genByEmail, setGenByEmail] = useState({});
  const [rowBusy, setRowBusy] = useState({}); // apollo_id -> "generating" | "followup"
  const [preview, setPreview] = useState(null); // { contact, id, data, loading }
  const [genDefaults, setGenDefaults] = useState({ email_intent: "", sender_context: "" });

  // Demo / test recipient — a throwaway address, pinned as row #0 in the table.
  const [demoName, setDemoName] = useState("");
  const [demoEmail, setDemoEmail] = useState("");
  const [demoCompany, setDemoCompany] = useState("");
  const [demoTitle, setDemoTitle] = useState("");
  const [demoStatus, setDemoStatus] = useState(null); // { state, error }
  const [showDemo, setShowDemo] = useState(false); // demo row hidden until toggled

  const [statusById, setStatusById] = useState({});
  const [bulkSending, setBulkSending] = useState(false);

  const [toast, setToast] = useState(null); // { msg, error }
  const toastTimer = useRef(null);
  const hydrated = useRef(false);

  function showToast(msg, error = false) {
    setToast({ msg, error });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/contacts");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load contacts");
        setContacts(data.contacts || []);
      } catch (e) {
        setLoadError(e.message);
      } finally {
        setLoading(false);
      }
    })();
    loadTemplates();

    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d.subject) setSubject(d.subject);
        if (d.body) setBody(d.body);
        if (d.activeTemplateId) setActiveTemplateId(String(d.activeTemplateId));
      }
      const rawDemo = localStorage.getItem(DEMO_KEY);
      if (rawDemo) {
        const dd = JSON.parse(rawDemo);
        if (dd.name) setDemoName(dd.name);
        if (dd.email) setDemoEmail(dd.email);
        if (dd.company) setDemoCompany(dd.company);
        if (dd.title) setDemoTitle(dd.title);
        if (dd.show) setShowDemo(true);
      }
      const rawGen = localStorage.getItem(GEN_FORM_KEY);
      if (rawGen) {
        const g = JSON.parse(rawGen);
        setGenDefaults({
          email_intent: g.email_intent || "",
          sender_context: g.sender_context || "",
        });
      }
    } catch {
      /* ignore corrupt draft */
    }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ subject, body, activeTemplateId }));
    } catch {
      /* non-fatal */
    }
  }, [subject, body, activeTemplateId]);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(
        DEMO_KEY,
        JSON.stringify({ name: demoName, email: demoEmail, company: demoCompany, title: demoTitle, show: showDemo })
      );
    } catch {
      /* non-fatal */
    }
  }, [demoName, demoEmail, demoCompany, demoTitle, showDemo]);

  useEffect(() => {
    if (!composerOpen) return;
    const onKey = (e) => e.key === "Escape" && setComposerOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composerOpen]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e) => e.key === "Escape" && setPreview(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  // Back to page 1 (and reset the range) whenever the filter changes.
  useEffect(() => {
    setPage(1);
    setRangeCount(0);
  }, [search]);

  async function loadTemplates() {
    try {
      const res = await fetch("/api/templates");
      const data = await res.json();
      if (res.ok) setTemplates(data.templates || []);
    } catch {
      /* templates are optional */
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) =>
      [c.name, c.company, c.title, c.email]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q))
    );
  }, [contacts, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const rangePct = filtered.length ? (Math.min(rangeCount, filtered.length) / filtered.length) * 100 : 0;

  const bodyReady = subject.trim() && body.trim();
  const activeTemplate = templates.find((t) => String(t.id) === String(activeTemplateId));

  const genOf = (contact) => (contact?.email ? genByEmail[contact.email.toLowerCase()] : null);

  // Ask the server which of the visible contacts already have a generated email.
  // Scoped to the page rather than the whole list: the selection can be 2,500
  // contacts and only ten of them are on screen.
  const pageKey = pageItems.map((c) => c.apollo_id).join(",");
  useEffect(() => {
    const emails = pageItems.map((c) => c.email).filter(Boolean);
    if (emails.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/email-testing/lookup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ emails }),
        });
        const data = await res.json();
        if (!res.ok || cancelled) return;
        setGenByEmail((prev) => ({ ...prev, ...(data.generated || {}) }));
      } catch {
        /* the table still works without it — Generate just stays offered */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey]);

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelected(new Set(filtered.map((c) => c.apollo_id)));
    setRangeCount(filtered.length);
  }

  function clearSelection() {
    setSelected(new Set());
    setRangeCount(0);
  }

  // The range slider selects the first N contacts of the filtered list (0…total).
  function applyRange(n) {
    setRangeCount(n);
    setSelected(new Set(filtered.slice(0, n).map((c) => c.apollo_id)));
  }

  // ── Template actions ────────────────────────────────────────────────────────
  function onPickTemplate(id) {
    setActiveTemplateId(id);
    if (!id) return;
    const t = templates.find((x) => String(x.id) === String(id));
    if (t) {
      setSubject(t.subject);
      setBody(t.body);
    }
  }

  async function saveAsTemplate() {
    if (!bodyReady) {
      showToast("Add a subject and a message before saving a template.", true);
      return;
    }
    const name = window.prompt("Name this template:", activeTemplate?.name || "");
    if (name == null) return;
    if (!name.trim()) {
      showToast("A template needs a name.", true);
      return;
    }
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), subject, body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save template");
      await loadTemplates();
      setActiveTemplateId(String(data.template.id));
      showToast(`Saved template “${data.template.name}”. ✓`);
    } catch (e) {
      showToast(e.message, true);
    }
  }

  async function updateTemplate() {
    if (!activeTemplate) return;
    if (!bodyReady) {
      showToast("Subject and message can't be empty.", true);
      return;
    }
    try {
      const res = await fetch(`/api/templates/${activeTemplate.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: activeTemplate.name, subject, body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not update template");
      await loadTemplates();
      showToast(`Updated “${activeTemplate.name}”. ✓`);
    } catch (e) {
      showToast(e.message, true);
    }
  }

  async function deleteTemplate() {
    if (!activeTemplate) return;
    if (!window.confirm(`Delete template “${activeTemplate.name}”?`)) return;
    try {
      const res = await fetch(`/api/templates/${activeTemplate.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not delete template");
      setActiveTemplateId("");
      await loadTemplates();
      showToast("Template deleted.");
    } catch (e) {
      showToast(e.message, true);
    }
  }

  function clearDraft() {
    setSubject("");
    setBody("");
    setActiveTemplateId("");
    showToast("Email cleared.");
  }

  // ── Generation ──────────────────────────────────────────────────────────────

  // Research this contact, write the org campaign if it has none yet, then write
  // their email. Lands in email_testing, so it shows up on the Generation tab.
  // Nothing is sent.
  // Regenerating writes a NEW email for this person and leaves the org campaign
  // alone: the campaign is shared by everyone at that institution, so silently
  // replacing it from one contact's row would rewrite their colleagues' framing
  // too. That switch lives on the Generation tab, where it is explicit.
  async function generateFor(contact) {
    const id = contact.apollo_id;
    if (rowBusy[id]) return;
    setRowBusy((b) => ({ ...b, [id]: "generating" }));
    try {
      const res = await fetch("/api/email-testing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          person: {
            full_name: contact.name || contact.email,
            email: contact.email,
            position: contact.title || undefined,
            university: contact.company || undefined,
          },
          email_intent: genDefaults.email_intent || undefined,
          sender_context: genDefaults.sender_context || undefined,
          run_label: "recipients",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");

      const row = {
        id: data.id,
        subject: data.email?.subject,
        body: data.email?.body,
        is_valid: Boolean(data.email?.valid),
        status: data.email?.valid ? "draft" : "rejected",
        org_name: data.research?.university?.name || contact.company,
        campaign_line: data.campaign?.campaign_line || null,
        warnings: data.email?.warnings || [],
        followup_count: 0,
        created_at: new Date().toISOString(),
      };
      setGenByEmail((prev) => ({ ...prev, [contact.email.toLowerCase()]: row }));
      showToast(
        data.email?.valid
          ? `Email written for ${contact.name || contact.email}. ✓`
          : "Written, but it failed a gate — read it in Preview before sending.",
        !data.email?.valid
      );
      openPreview(contact, data.id);
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setRowBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    }
  }

  // The 2-step sequence for an already-generated email. Step 1 (+3 days) adds one
  // new specific; step 2 (+7 days) is short and easy to decline.
  async function followupFor(contact, { regenerate = false } = {}) {
    const gen = genOf(contact);
    if (!gen) {
      showToast("Generate the email first — a follow-up is written against it.", true);
      return;
    }
    const id = contact.apollo_id;
    if (rowBusy[id]) return;
    setRowBusy((b) => ({ ...b, [id]: "followup" }));
    try {
      const res = await fetch("/api/followup-testing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email_testing_id: gen.id, steps: [1, 2], regenerate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Follow-up generation failed");
      const steps = data.followups || [];
      setGenByEmail((prev) => ({
        ...prev,
        [contact.email.toLowerCase()]: { ...gen, followup_count: steps.length },
      }));
      showToast(`${steps.filter((f) => f.valid).length}/${steps.length} follow-up steps passed every gate.`);
      openPreview(contact, gen.id, "followups");
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setRowBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    }
  }

  // Preview — the generated email exactly as it will be sent, with its follow-up
  // steps and the gates it passed or failed. `focus` scrolls straight to the
  // sequence, so the Follow-up column's Preview lands on the follow-ups rather
  // than making you scroll past the email you have already read.
  async function openPreview(contact, runId, focus = null) {
    const id = runId || genOf(contact)?.id;
    if (!id) return;
    setPreview({ contact, id, focus, loading: true, data: null });
    try {
      const res = await fetch(`/api/email-testing/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load the generated email");
      setPreview({ contact, id, focus, loading: false, data });
    } catch (e) {
      setPreview({ contact, id, focus, loading: false, data: null, error: e.message });
    }
  }

  // ── Sending ─────────────────────────────────────────────────────────────────

  // One send path for everything. `prefer_generated` makes the server use each
  // contact's generated email where there is one and the draft where there is
  // not — Send never writes an email.
  async function sendToIds(ids, { allowRejected = false } = {}) {
    if (ids.length === 0) {
      showToast("No contacts selected.", true);
      return null;
    }
    setStatusById((prev) => {
      const next = { ...prev };
      ids.forEach((id) => (next[id] = { state: "sending" }));
      return next;
    });
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids,
          prefer_generated: true,
          allow_rejected: allowRejected,
          ...(bodyReady
            ? {
                subject,
                html: htmlFromBody(body),
                text: body,
                templateId: activeTemplate ? activeTemplate.id : null,
              }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Send failed");
      setStatusById((prev) => {
        const next = { ...prev };
        for (const r of data.results || []) {
          next[r.id] = r.ok ? { state: "sent", source: r.source } : { state: "error", error: r.error };
        }
        return next;
      });
      if (data.failed > 0) {
        showToast(`Sent ${data.sent}, failed ${data.failed}. Hover a red pill for the reason.`, true);
      } else {
        showToast(
          `Sent ${data.sent} email${data.sent === 1 ? "" : "s"}` +
            (data.fromGenerated ? ` (${data.fromGenerated} generated)` : "") +
            ". ✓"
        );
      }
      return data;
    } catch (e) {
      setStatusById((prev) => {
        const next = { ...prev };
        ids.forEach((id) => (next[id] = { state: "error", error: e.message }));
        return next;
      });
      showToast(e.message, true);
      return null;
    }
  }

  async function handleSendOne(contact) {
    const gen = genOf(contact);
    if (!gen && !bodyReady) {
      showToast("Generate an email for this contact, or set one email for everyone.", true);
      return;
    }
    // A draft that failed a gate is refused by the server unless the sender says
    // they have read it. Ask here rather than sending something unreviewed.
    let allowRejected = false;
    if (gen && !gen.is_valid) {
      const ok = window.confirm(
        `${contact.name || contact.email}'s generated email did not pass every validation gate.\n\n` +
          `Send it anyway? Real email — this cannot be undone.`
      );
      if (!ok) return;
      allowRejected = true;
    } else {
      const ok = window.confirm(
        gen
          ? `Send the generated email to ${contact.email}?\n\nReal email — this cannot be undone.`
          : `Send the email you set to ${contact.email}?\n\nReal email — this cannot be undone.`
      );
      if (!ok) return;
    }
    await sendToIds([contact.apollo_id], { allowRejected });
  }

  async function handleSendBulk() {
    const ids = [...selected];
    if (ids.length === 0) {
      showToast("Select some contacts (or a range) first.", true);
      return;
    }
    const n = ids.length;
    const ok = window.confirm(
      `Send to ${n} contact${n === 1 ? "" : "s"}?\n\n` +
        `Each contact gets their own generated email where one exists` +
        (bodyReady ? `, and the email you set where it does not.` : `. Contacts with no generated email are skipped.`) +
        `\n\nDrafts that failed a validation gate are skipped — send those one at a time after reading them in Preview.` +
        `\n\nReal email via Brevo. This cannot be undone.`
    );
    if (!ok) return;
    setBulkSending(true);
    try {
      await sendToIds(ids);
    } finally {
      setBulkSending(false);
    }
  }

  async function sendDemo() {
    if (!bodyReady) {
      showToast("Set the email first (top-right).", true);
      setComposerOpen(true);
      return;
    }
    if (!demoEmail.trim()) {
      showToast("Enter a demo email address to test with.", true);
      return;
    }
    setDemoStatus({ state: "sending" });
    try {
      const res = await fetch("/api/send-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: demoName,
          email: demoEmail.trim(),
          company: demoCompany,
          title: demoTitle,
          subject,
          html: htmlFromBody(body),
          text: body,
          templateId: activeTemplate ? activeTemplate.id : null,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Test send failed");
      setDemoStatus({ state: "sent" });
      showToast(`Sent test to ${demoEmail.trim()}. ✓`);
    } catch (e) {
      setDemoStatus({ state: "error", error: e.message });
      showToast(e.message, true);
    }
  }

  function removeDemo() {
    setShowDemo(false);
    setDemoName("");
    setDemoEmail("");
    setDemoCompany("");
    setDemoTitle("");
    setDemoStatus(null);
    showToast("Demo user removed.");
  }

  const allOnPageSelected =
    pageItems.length > 0 && pageItems.every((c) => selected.has(c.apollo_id));

  function togglePage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) pageItems.forEach((c) => next.delete(c.apollo_id));
      else pageItems.forEach((c) => next.add(c.apollo_id));
      return next;
    });
  }

  return (
    <div className="min-h-screen">
      <AppHeader
        active="recipients"
        width="max-w-7xl"
        subtitle="Generate an email per contact, read it, then send."
        actions={
          <button className={btnPrimary} onClick={() => setComposerOpen(true)}>
            Set email
          </button>
        }
      />

      <main className="mx-auto max-w-7xl px-5 py-6">
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-900">
              Recipients
              <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                {filtered.length}
              </span>
            </h2>
            <div className="relative ml-auto">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                🔍
              </span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, company, title, email…"
                className={`${inputCls} pl-9 sm:w-80`}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_17rem]">
            {/* Left column: demo toggle + the recipients table */}
            <div className="min-w-0 space-y-4">
            {/* Top bar — Demo toggle (left) · bulk Send (right, above the Send column) */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                className={
                  showDemo
                    ? "inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-100 px-2.5 py-1.5 text-xs font-semibold text-amber-800 transition hover:bg-amber-200"
                    : btnGhostSm
                }
                onClick={() => setShowDemo((v) => !v)}
                title="Show/hide a demo test-recipient row"
              >
                🧪 Demo user
              </button>
              <button
                className={btnPrimary}
                onClick={handleSendBulk}
                disabled={bulkSending || selected.size === 0}
                title="Sends each contact their generated email, or the email you set"
              >
                {bulkSending ? "Sending…" : `Send to ${selected.size} selected`}
              </button>
            </div>

            <p className="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
              <span className="font-semibold text-slate-700">✨ Generate</span>
              researches the contact and writes their email ·
              <span className="font-semibold text-slate-700">↪ Follow-up</span>
              adds the 2-step sequence ·
              <span className="font-semibold text-slate-700">Send</span>
              only sends what is already written.
              <Link href="/generation" className="ml-auto font-medium text-blue-600 hover:underline">
                Generation tab ↗
              </Link>
            </p>

            {loading && <p className="text-sm text-slate-500">Loading contacts…</p>}
            {loadError && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Could not load contacts: {loadError}
              </p>
            )}

            {!loading && !loadError && (
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <div className="scrollbar-thin overflow-x-auto">
                  <table className="w-full min-w-[1080px] table-fixed text-sm text-center">
                    <colgroup>
                      <col className="w-12" />
                      <col className="w-12" />
                      <col className="w-[14%]" />
                      <col className="w-[15%]" />
                      <col className="w-[15%]" />
                      <col className="w-[19%]" />
                      <col className="w-28" />
                      <col className="w-28" />
                      <col className="w-24" />
                      <col className="w-20" />
                    </colgroup>
                    <thead className="bg-slate-50">
                      <tr>
                        <th className={thCls}>
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            checked={allOnPageSelected}
                            onChange={togglePage}
                            title="Select everyone on this page"
                          />
                        </th>
                        <th className={thCls}>#</th>
                        <th className={thCls}>Name</th>
                        <th className={thCls}>Title</th>
                        <th className={thCls}>Company</th>
                        <th className={thCls}>Email</th>
                        <th className={thCls}>Generate</th>
                        <th className={thCls}>Follow-up</th>
                        <th className={thCls}>Status</th>
                        <th className={thCls}>Send</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {/* Demo / test recipient — row #0, shown only via the "Demo user" button. */}
                      {showDemo && (
                        <tr className="bg-amber-50/70">
                          <td className="px-3 py-2.5 align-middle">
                            <button
                              onClick={removeDemo}
                              title="Remove demo user"
                              aria-label="Remove demo user"
                              className="mx-auto grid h-7 w-7 place-items-center rounded-md text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                            >
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={2}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="h-4 w-4"
                              >
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              </svg>
                            </button>
                          </td>
                          <td className="px-3 py-2.5 align-middle font-bold text-amber-700">0</td>
                        <td className="px-3 py-2 align-middle">
                          <input
                            type="text"
                            value={demoName}
                            onChange={(e) => setDemoName(e.target.value)}
                            placeholder="Demo name"
                            className={`${inputCls} py-1.5 text-center`}
                          />
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <input
                            type="text"
                            value={demoTitle}
                            onChange={(e) => setDemoTitle(e.target.value)}
                            placeholder="Demo title"
                            className={`${inputCls} py-1.5 text-center`}
                          />
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <input
                            type="text"
                            value={demoCompany}
                            onChange={(e) => setDemoCompany(e.target.value)}
                            placeholder="Demo company"
                            className={`${inputCls} py-1.5 text-center`}
                          />
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <input
                            type="email"
                            value={demoEmail}
                            onChange={(e) => setDemoEmail(e.target.value)}
                            placeholder="you@example.com"
                            className={`${inputCls} py-1.5 text-center`}
                          />
                        </td>
                        {/* Generation is per real contact — the demo row only tests the fixed email. */}
                        <td className="px-3 py-2.5 align-middle text-slate-300">—</td>
                        <td className="px-3 py-2.5 align-middle text-slate-300">—</td>
                        <td className="px-3 py-2.5 align-middle">
                          {demoStatus?.state === "sending" && <span className="text-slate-400">Sending…</span>}
                          {demoStatus?.state === "sent" && <span className={pillSent}>Sent</span>}
                          {demoStatus?.state === "error" && (
                            <span className={`${pillFailed} cursor-help`} title={demoStatus.error}>
                              Failed
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 align-middle">
                          <button
                            className={btnGhostSm}
                            onClick={sendDemo}
                            disabled={demoStatus?.state === "sending" || !bodyReady || !demoEmail.trim()}
                            title={
                              !bodyReady
                                ? "Set the email first (top-right)"
                                : !demoEmail.trim()
                                ? "Enter a demo email first"
                                : "Send the email you set to the demo address"
                            }
                          >
                            Send test
                          </button>
                        </td>
                      </tr>
                      )}

                      {pageItems.map((c, i) => {
                        const st = statusById[c.apollo_id];
                        const gen = genOf(c);
                        const busy = rowBusy[c.apollo_id];
                        const rowNum = (currentPage - 1) * PAGE_SIZE + i + 1;
                        return (
                          <tr key={c.apollo_id} className="hover:bg-slate-50">
                            <td className="px-3 py-2.5 align-middle">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                checked={selected.has(c.apollo_id)}
                                onChange={() => toggleOne(c.apollo_id)}
                              />
                            </td>
                            <td className="px-3 py-2.5 align-middle text-slate-400">{rowNum}</td>
                            <td className="truncate px-3 py-2.5 align-middle font-medium text-slate-900" title={c.name || ""}>
                              {c.name || <span className="text-slate-400">—</span>}
                            </td>
                            <td className="truncate px-3 py-2.5 align-middle text-slate-500" title={c.title || ""}>
                              {c.title || "—"}
                            </td>
                            <td className="truncate px-3 py-2.5 align-middle text-slate-700" title={c.company || ""}>
                              {c.company || <span className="text-slate-400">—</span>}
                            </td>
                            <td className="truncate px-3 py-2.5 align-middle text-slate-500" title={c.email}>
                              {c.email}
                            </td>

                            {/* Generate — becomes Preview once there is an email to read. */}
                            <td className="px-3 py-2.5 align-middle">
                              {busy === "generating" ? (
                                <span className="text-xs text-violet-500">✨ Writing…</span>
                              ) : gen ? (
                                <button
                                  className={btnGhostSm}
                                  onClick={() => openPreview(c)}
                                  title={gen.subject || "Read the generated email"}
                                >
                                  👁 Preview
                                </button>
                              ) : (
                                <button
                                  className={btnGhostSm}
                                  onClick={() => generateFor(c)}
                                  disabled={Boolean(busy)}
                                  title="Research this contact and write their email (30–90s). Sends nothing."
                                >
                                  ✨ Generate
                                </button>
                              )}
                            </td>

                            {/* Follow-up — the 2-step sequence for that email. */}
                            <td className="px-3 py-2.5 align-middle">
                              {busy === "followup" ? (
                                <span className="text-xs text-violet-500">↪ Writing…</span>
                              ) : gen?.followup_count > 0 ? (
                                <button
                                  className={btnGhostSm}
                                  onClick={() => openPreview(c, null, "followups")}
                                  title={`Read the ${gen.followup_count}-step follow-up sequence`}
                                >
                                  👁 Preview ({gen.followup_count})
                                </button>
                              ) : (
                                <button
                                  className={btnGhostSm}
                                  onClick={() => followupFor(c)}
                                  disabled={!gen || Boolean(busy)}
                                  title={gen ? "Write the 2-step follow-up sequence" : "Generate the email first"}
                                >
                                  ↪ Follow-up
                                </button>
                              )}
                            </td>

                            <td className="px-3 py-2.5 align-middle">
                              {st?.state === "sending" ? (
                                <span className="text-slate-400">Sending…</span>
                              ) : st?.state === "sent" ? (
                                <span className={pillSent}>Sent</span>
                              ) : st?.state === "error" ? (
                                <span className={`${pillFailed} cursor-help`} title={st.error}>
                                  Failed
                                </span>
                              ) : gen ? (
                                <span
                                  className={
                                    gen.is_valid
                                      ? "inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700"
                                      : "inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
                                  }
                                  title={gen.is_valid ? "Generated draft, passed every gate" : "Generated, but failed a gate"}
                                >
                                  {gen.is_valid ? "Draft" : "Rejected"}
                                </span>
                              ) : null}
                            </td>

                            <td className="px-3 py-2.5 align-middle">
                              <button
                                className={btnGhostSm}
                                onClick={() => handleSendOne(c)}
                                disabled={st?.state === "sending" || (!gen && !bodyReady)}
                                title={
                                  gen
                                    ? "Send the generated email"
                                    : bodyReady
                                    ? "Send the email you set"
                                    : "Generate an email, or set one for everyone"
                                }
                              >
                                Send
                              </button>
                            </td>
                          </tr>
                        );
                      })}

                      {pageItems.length === 0 && (
                        <tr>
                          <td colSpan={10} className="px-3 py-8 text-center text-slate-400">
                            No contacts match.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <Pagination
                  page={currentPage}
                  pageCount={pageCount}
                  total={filtered.length}
                  pageSize={PAGE_SIZE}
                  onChange={setPage}
                  label="contacts"
                />
              </div>
            )}
            </div>

            {/* Right rail — Range selector + selection actions, in the free space beside the table */}
            <aside className="xl:col-start-2 xl:row-start-1">
              <div className="sticky top-24 space-y-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
                {/* Range */}
                <div>
                  <div className="flex items-center justify-between">
                    <label className={`${labelCls} mb-0`}>Range</label>
                    <span className="text-sm font-semibold text-slate-700">
                      {rangeCount > 0 ? `First ${rangeCount}` : "0"}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={filtered.length}
                    value={Math.min(rangeCount, filtered.length)}
                    onChange={(e) => applyRange(Number(e.target.value))}
                    disabled={filtered.length === 0}
                    aria-label="Select the first N contacts"
                    className="range-slider mt-3 w-full"
                    style={{
                      background: `linear-gradient(to right, #2563eb 0%, #2563eb ${rangePct}%, #e2e8f0 ${rangePct}%, #e2e8f0 100%)`,
                    }}
                  />
                  <div className="mt-1 flex justify-between text-xs font-medium text-slate-400">
                    <span>0</span>
                    <span>{filtered.length}</span>
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-slate-500">
                    {rangeCount > 0
                      ? `Selecting the first ${rangeCount} of ${filtered.length} contacts.`
                      : "Drag to select the first N contacts."}
                  </p>
                </div>

                {/* Selection actions — below the range bar */}
                <div className="space-y-2 border-t border-slate-200 pt-4">
                  <button className={`${btnGhost} w-full`} onClick={selectAllFiltered}>
                    Select all ({filtered.length})
                  </button>
                  <div className="flex items-center justify-between">
                    <button className={btnGhostSm} onClick={clearSelection}>
                      Clear
                    </button>
                    <span className="text-sm font-semibold text-slate-700">
                      {selected.size} selected
                    </span>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </section>
      </main>

      {/* Preview — the generated email, its gates and its follow-up steps */}
      {preview && (
        <PreviewModal
          preview={preview}
          busy={rowBusy[preview.contact.apollo_id]}
          onClose={() => setPreview(null)}
          onRegenerate={() => generateFor(preview.contact)}
          onFollowup={(regenerate) => followupFor(preview.contact, { regenerate })}
          onSend={() => handleSendOne(preview.contact)}
        />
      )}

      {/* Composer modal */}
      {composerOpen && (
        <div
          className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm"
          onClick={() => setComposerOpen(false)}
        >
          <div
            className="my-8 w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">Set email</h2>
                <p className="text-xs text-slate-500">
                  The fallback for contacts with no generated email. Saved automatically and reused until you change it.
                </p>
              </div>
              <button
                className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                onClick={() => setComposerOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 p-5">
              <div>
                <label className={labelCls}>Template</label>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={activeTemplateId}
                    onChange={(e) => onPickTemplate(e.target.value)}
                    className={`${inputCls} flex-1 basis-56`}
                  >
                    <option value="">— New message (no template) —</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <button className={btnGhostSm} onClick={saveAsTemplate}>
                    Save as new
                  </button>
                  <button className={btnGhostSm} onClick={updateTemplate} disabled={!activeTemplate}>
                    Update
                  </button>
                  <button className={btnGhostSm} onClick={deleteTemplate} disabled={!activeTemplate}>
                    Delete
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-slate-500">
                  Pick a saved template to load it, or write one and <strong>Save as new</strong>. Templates
                  live in the <code className={codeCls}>email_templates</code> table and are still
                  personalized per recipient.
                </p>
              </div>

              <div>
                <label className={labelCls}>Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Hi {{first_name}}, quick question about {{company}}"
                  className={inputCls}
                />
              </div>

              <div>
                <label className={labelCls}>Message</label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={"Hi {{first_name}},\n\n...\n\nBest,\nYour Name"}
                  className={`${inputCls} min-h-[180px] resize-y leading-relaxed`}
                />
                <p className="mt-1.5 text-xs text-slate-500">
                  Personalize with <code className={codeCls}>{"{{first_name}}"}</code>,{" "}
                  <code className={codeCls}>{"{{name}}"}</code>, <code className={codeCls}>{"{{company}}"}</code>,{" "}
                  <code className={codeCls}>{"{{title}}"}</code>. Line breaks become paragraphs in the email.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-4">
              <button
                className="text-sm font-medium text-slate-500 transition hover:text-red-600 disabled:opacity-50"
                onClick={clearDraft}
                disabled={!subject && !body}
              >
                Clear email
              </button>
              <button className={btnPrimary} onClick={() => setComposerOpen(false)}>
                {bodyReady ? "Save & close" : "Close"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          className={`fixed bottom-5 right-5 z-50 max-w-sm rounded-lg px-4 py-3 text-sm text-white shadow-xl ${
            toast.error ? "bg-red-700" : "bg-slate-900"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// The generated email exactly as it will go out, with the gates it passed or
// failed and the follow-up steps written against it. Read before send — that is
// the whole reason Send no longer generates.
function PreviewModal({ preview, busy, onClose, onRegenerate, onFollowup, onSend }) {
  const { contact, data, loading, error, focus } = preview;
  const run = data?.run;
  const followups = data?.followups || [];
  const failedGates = Object.entries(run?.validation || {}).filter(([, g]) => !g?.pass);
  const sequenceRef = useRef(null);

  // Opened from the Follow-up column: show the sequence, not the top of an email
  // that has already been read.
  useEffect(() => {
    if (focus === "followups" && sequenceRef.current) {
      sequenceRef.current.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [focus, data]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-8 w-full max-w-3xl rounded-xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Preview</h2>
            <p className="text-xs text-slate-500">
              {contact.name || contact.email}
              {contact.company ? ` · ${contact.company}` : ""} — generated, not sent.
            </p>
          </div>
          <button
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto p-5">
          {loading && <p className="text-sm text-slate-500">Loading the generated email…</p>}
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          {run && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={
                    run.is_valid
                      ? "inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700"
                      : "inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
                  }
                >
                  {run.is_valid ? "Passed all gates" : "Failed a gate"}
                </span>
                {run.campaign_output?.campaign_line && (
                  <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                    🎯 {run.campaign_output.campaign_line}
                  </span>
                )}
                {run.coverage && (
                  <span className="text-[11px] text-slate-400">coverage {run.coverage}</span>
                )}
                <a
                  href={`/generation?run=${run.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-xs font-medium text-blue-600 hover:underline"
                >
                  Open in Generation ↗
                </a>
              </div>

              <article className="overflow-hidden rounded-xl border border-slate-200">
                <div className="space-y-1 border-b border-slate-100 bg-slate-50 px-4 py-3 text-left">
                  <p className="text-xs text-slate-500">
                    To <span className="font-medium text-slate-700">{run.person_name || contact.name}</span>
                    {run.person_email ? ` <${run.person_email}>` : ""}
                  </p>
                  <p className="text-base font-semibold text-slate-900">{run.subject || "(no subject)"}</p>
                </div>
                <div className="whitespace-pre-wrap px-4 py-4 text-left text-sm leading-relaxed text-slate-800">
                  {run.body || "(no body)"}
                </div>
              </article>

              {(run.warnings || []).length > 0 && (
                <ul className="space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {run.warnings.map((w, i) => (
                    <li key={i}>⚠ {w}</li>
                  ))}
                </ul>
              )}

              {failedGates.length > 0 && (
                <ul className="space-y-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                  {failedGates.map(([name, g]) => (
                    <li key={name}>
                      <span className="font-semibold">{name}</span>
                      {g?.detail ? ` — ${g.detail}` : ""}
                    </li>
                  ))}
                </ul>
              )}

              <div ref={sequenceRef} className="scroll-mt-2">
                <div className="flex items-center justify-between">
                  <p className={labelCls}>Follow-up sequence</p>
                  {followups.length > 0 && (
                    <button className={btnGhostSm} onClick={() => onFollowup(true)} disabled={Boolean(busy)}>
                      ↻ Regenerate
                    </button>
                  )}
                </div>
                {followups.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-slate-300 px-3 py-3 text-xs text-slate-400">
                    No follow-ups yet. Step 1 (+3 days) adds one new specific and makes the ask smaller; step 2
                    (+7 days) is the shortest and easiest to decline.
                  </p>
                ) : (
                  <ol className="space-y-2">
                    {followups.map((f) => (
                      <li key={f.id} className="rounded-lg border border-slate-200 px-4 py-3 text-left">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                            Step {f.step_number} · +{f.send_after_days ?? "?"} days
                          </span>
                          <span
                            className={
                              f.is_valid
                                ? "inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700"
                                : "inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
                            }
                          >
                            {f.is_valid ? "Draft" : "Rejected"}
                          </span>
                        </div>
                        <p className="mt-2 text-sm font-semibold text-slate-900">{f.subject || "(no subject)"}</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                          {f.body || "(no body)"}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <button className={btnGhostSm} onClick={onRegenerate} disabled={Boolean(busy)}>
              {busy === "generating" ? "✨ Writing…" : "✨ Regenerate"}
            </button>
            {followups.length === 0 && (
              <button className={btnGhostSm} onClick={() => onFollowup(false)} disabled={Boolean(busy) || !run}>
                {busy === "followup" ? "↪ Writing…" : "↪ Generate follow-ups"}
              </button>
            )}
          </div>
          <button className={btnPrimary} onClick={onSend} disabled={!run?.subject}>
            Send this email
          </button>
        </div>
      </div>
    </div>
  );
}

// htmlFromBody moved to @/lib/htmlBody so the worker can reuse it.
