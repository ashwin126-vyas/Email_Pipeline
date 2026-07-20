"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Pagination from "@/components/Pagination";
import {
  btnPrimary,
  btnGhost,
  btnGhostSm,
  inputCls,
  labelCls,
  codeCls,
  tabLink,
  pillSent,
  pillFailed,
  thCls,
} from "@/lib/ui";

const DRAFT_KEY = "brevoEmailDraft.v1";
const DEMO_KEY = "brevoDemoRecipient.v1";
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

  // Demo / test recipient — a throwaway address, pinned as row #0 in the table.
  const [demoName, setDemoName] = useState("");
  const [demoEmail, setDemoEmail] = useState("");
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
        if (dd.show) setShowDemo(true);
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
      localStorage.setItem(DEMO_KEY, JSON.stringify({ name: demoName, email: demoEmail, show: showDemo }));
    } catch {
      /* non-fatal */
    }
  }, [demoName, demoEmail, showDemo]);

  useEffect(() => {
    if (!composerOpen) return;
    const onKey = (e) => e.key === "Escape" && setComposerOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composerOpen]);

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

  async function sendToIds(ids) {
    if (!bodyReady) {
      showToast("Set the email first (top-right).", true);
      setComposerOpen(true);
      return;
    }
    if (ids.length === 0) {
      showToast("No contacts selected.", true);
      return;
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
          subject,
          html: htmlFromBody(body),
          text: body,
          templateId: activeTemplate ? activeTemplate.id : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Send failed");
      setStatusById((prev) => {
        const next = { ...prev };
        for (const r of data.results || []) {
          next[r.id] = r.ok ? { state: "sent" } : { state: "error", error: r.error };
        }
        return next;
      });
      if (data.failed > 0) {
        showToast(`Sent ${data.sent}, failed ${data.failed}. Hover a red pill for the reason.`, true);
      } else {
        showToast(`Sent ${data.sent} email${data.sent === 1 ? "" : "s"}. ✓`);
      }
    } catch (e) {
      setStatusById((prev) => {
        const next = { ...prev };
        ids.forEach((id) => (next[id] = { state: "error", error: e.message }));
        return next;
      });
      showToast(e.message, true);
    }
  }

  async function handleSendOne(contact) {
    await sendToIds([contact.apollo_id]);
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
          subject,
          html: htmlFromBody(body),
          text: body,
          templateId: activeTemplate ? activeTemplate.id : null,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Test send failed");
      setDemoStatus({ state: "sent" });
      showToast(`Test email sent to ${demoEmail.trim()}. ✓`);
    } catch (e) {
      setDemoStatus({ state: "error", error: e.message });
      showToast(e.message, true);
    }
  }

  function removeDemo() {
    setShowDemo(false);
    setDemoName("");
    setDemoEmail("");
    setDemoStatus(null);
    showToast("Demo user removed.");
  }

  async function handleSendBulk() {
    const ids = [...selected];
    if (ids.length === 0) {
      showToast("Select some contacts (or a range) first.", true);
      return;
    }
    if (!bodyReady) {
      showToast("Set the email first (top-right).", true);
      setComposerOpen(true);
      return;
    }
    const ok = window.confirm(
      `Send this email to ${ids.length} contact${ids.length === 1 ? "" : "s"}?\n\nThis sends real email via Brevo and cannot be undone.`
    );
    if (!ok) return;
    setBulkSending(true);
    try {
      await sendToIds(ids);
    } finally {
      setBulkSending(false);
    }
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
      {/* Sticky header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-5 py-3">
          <div className="mr-auto">
            <h1 className="flex items-center gap-2 text-lg font-bold text-slate-900">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-blue-600 text-sm text-white">
                ✉
              </span>
              Brevo Email Pipeline
            </h1>
            <p className="mt-0.5 text-xs text-slate-500">
              Email your saved contacts via Brevo — one at a time, or a whole range at once.
            </p>
          </div>

          <Link href="/sends" className={tabLink}>
            <span>📤</span> Emailed Send
          </Link>

          <button className={btnPrimary} onClick={() => setComposerOpen(true)}>
            Set email
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-5 py-6">
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-900">Recipients</h2>
          </div>

          <div className="grid grid-cols-1 gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_17rem]">
            {/* Left column: demo toggle + the recipients table */}
            <div className="min-w-0 space-y-4">
            {/* Demo user toggle — left side */}
            <div className="flex">
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
            </div>

            {loading && <p className="text-sm text-slate-500">Loading contacts…</p>}
            {loadError && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Could not load contacts: {loadError}
              </p>
            )}

            {!loading && !loadError && (
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <div className="scrollbar-thin overflow-x-auto">
                  <table className="w-full min-w-[880px] table-fixed text-sm text-center">
                    <colgroup>
                      <col className="w-12" />
                      <col className="w-14" />
                      <col className="w-[16%]" />
                      <col className="w-[20%]" />
                      <col className="w-[20%]" />
                      <col className="w-[24%]" />
                      <col className="w-24" />
                      <col className="w-28" />
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
                        <th className={thCls}>Status</th>
                        <th className={thCls}>Action</th>
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
                        <td className="px-3 py-2.5 align-middle text-slate-300">—</td>
                        <td className="px-3 py-2.5 align-middle text-slate-300">—</td>
                        <td className="px-3 py-2 align-middle">
                          <input
                            type="email"
                            value={demoEmail}
                            onChange={(e) => setDemoEmail(e.target.value)}
                            placeholder="you@example.com"
                            className={`${inputCls} py-1.5 text-center`}
                          />
                        </td>
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
                                : "Send this email to the demo address"
                            }
                          >
                            Send test
                          </button>
                        </td>
                      </tr>
                      )}

                      {pageItems.map((c, i) => {
                        const st = statusById[c.apollo_id];
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
                            <td className="px-3 py-2.5 align-middle">
                              {st?.state === "sending" && <span className="text-slate-400">Sending…</span>}
                              {st?.state === "sent" && <span className={pillSent}>Sent</span>}
                              {st?.state === "error" && (
                                <span className={`${pillFailed} cursor-help`} title={st.error}>
                                  Failed
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 align-middle">
                              <button
                                className={btnGhostSm}
                                onClick={() => handleSendOne(c)}
                                disabled={st?.state === "sending" || !bodyReady}
                                title={!bodyReady ? "Set the email first (top-right)" : undefined}
                              >
                                Send
                              </button>
                            </td>
                          </tr>
                        );
                      })}

                      {pageItems.length === 0 && (
                        <tr>
                          <td colSpan={8} className="px-3 py-8 text-center text-slate-400">
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

                {/* Selection actions — moved here, below the range bar */}
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
                  <button
                    className={`${btnPrimary} w-full`}
                    onClick={handleSendBulk}
                    disabled={bulkSending || selected.size === 0 || !bodyReady}
                    title={!bodyReady ? "Set the email first (top-right)" : undefined}
                  >
                    {bulkSending ? "Sending…" : `Send to ${selected.size} selected`}
                  </button>
                </div>
              </div>
            </aside>
          </div>
        </section>
      </main>

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
                <p className="text-xs text-slate-500">Saved automatically and reused until you change it.</p>
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

function htmlFromBody(text) {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1d21">${paragraphs}</div>`;
}
