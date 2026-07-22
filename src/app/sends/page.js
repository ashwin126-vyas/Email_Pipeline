"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Pagination from "@/components/Pagination";
import AppHeader from "@/components/AppHeader";
import { tabLink, btnGhostSm, pillSent, pillFailed, thCls, statTile } from "@/lib/ui";

const PAGE_SIZE = 10;

export default function SendsPage() {
  const [sends, setSends] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("all"); // all | sent | failed
  const [deletingId, setDeletingId] = useState(null);
  const [viewing, setViewing] = useState(null); // the send row whose full email is open

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/sends");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load send history");
      setSends(data.sends || []);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    setPage(1);
  }, [statusFilter]);

  async function handleDelete(s) {
    if (!confirm("Delete this entry from the send log? This only removes the history row — it does not unsend the email.")) {
      return;
    }
    setDeletingId(s.id);
    try {
      const res = await fetch(`/api/sends/${s.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to delete entry");
      setSends((prev) => prev.filter((row) => row.id !== s.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setDeletingId(null);
    }
  }

  const sentCount = sends.filter((s) => s.status === "sent").length;
  const failedCount = sends.length - sentCount;

  const filtered = useMemo(() => {
    if (statusFilter === "all") return sends;
    return sends.filter((s) => (statusFilter === "sent" ? s.status === "sent" : s.status !== "sent"));
  }, [sends, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const chip = (key, label, count, active) => (
    <button
      onClick={() => setStatusFilter(key)}
      className={
        "rounded-full px-3 py-1 text-xs font-semibold transition " +
        (active
          ? "bg-blue-600 text-white"
          : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50")
      }
    >
      {label} {count != null && <span className="opacity-70">({count})</span>}
    </button>
  );

  return (
    <div className="min-h-screen">
      <AppHeader
        active="sends"
        subtitle="Every email sent through Brevo — successes and failures, newest first."
      />

      <main className="mx-auto max-w-6xl space-y-6 px-5 py-6">
        <section className="grid gap-3 sm:grid-cols-3">
          <div className={statTile}>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Total logged
            </div>
            <div className="mt-1 text-2xl font-bold text-slate-900">{sends.length}</div>
          </div>
          <div className={statTile}>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Sent</div>
            <div className="mt-1 text-2xl font-bold text-emerald-600">{sentCount}</div>
          </div>
          <div className={statTile}>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Failed</div>
            <div className="mt-1 text-2xl font-bold text-red-600">{failedCount}</div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-900">Sent history</h2>
            <div className="flex items-center gap-1.5">
              {chip("all", "All", sends.length, statusFilter === "all")}
              {chip("sent", "Sent", sentCount, statusFilter === "sent")}
              {chip("failed", "Failed", failedCount, statusFilter === "failed")}
            </div>
            <button className={`${btnGhostSm} ml-auto`} onClick={load}>
              ↻ Refresh
            </button>
          </div>

          <div className="p-5">
            {loading && <p className="text-sm text-slate-500">Loading history…</p>}
            {error && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}

            {!loading && !error && filtered.length === 0 && (
              <div className="py-12 text-center">
                <div className="text-3xl">📭</div>
                <p className="mt-2 text-sm text-slate-500">
                  {sends.length === 0
                    ? "No emails sent yet. Send one from the Recipients page and it will appear here."
                    : "No emails match this filter."}
                </p>
                <Link href="/" className={`${tabLink} mt-4`}>
                  Go to Recipients
                </Link>
              </div>
            )}

            {!loading && !error && filtered.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <div className="scrollbar-thin overflow-x-auto">
                  <table className="w-full text-sm text-center">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className={`${thCls} w-16`}>#</th>
                        <th className={thCls}>When</th>
                        <th className={thCls}>Name</th>
                        <th className={thCls}>Company</th>
                        <th className={thCls}>Email</th>
                        <th className={thCls}>Subject</th>
                        <th className={thCls}>Template</th>
                        <th className={`${thCls} w-24`}>Status</th>
                        <th className={`${thCls} w-16`}></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {pageItems.map((s, i) => (
                        <tr
                          key={s.id}
                          onClick={() => setViewing(s)}
                          title="Click to view the full email"
                          className="cursor-pointer hover:bg-slate-50"
                        >
                          <td className="px-3 py-2.5 align-middle text-slate-400">
                            {(currentPage - 1) * PAGE_SIZE + i + 1}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 align-middle text-slate-400">
                            {formatWhen(s.sent_at)}
                          </td>
                          <td className="px-3 py-2.5 align-middle font-medium text-slate-900">
                            <span className="inline-flex items-center gap-1.5">
                              {s.name || <span className="text-slate-400">—</span>}
                              {s.apollo_id === "demo" && (
                                <span className="rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-800">
                                  Demo
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 align-middle text-slate-700">
                            {s.company || <span className="text-slate-400">—</span>}
                          </td>
                          <td className="px-3 py-2.5 align-middle text-slate-500">{s.email}</td>
                          <td className="max-w-[260px] truncate px-3 py-2.5 align-middle text-slate-700">
                            {s.subject}
                          </td>
                          <td className="px-3 py-2.5 align-middle text-slate-500">
                            {s.template_name || "—"}
                          </td>
                          <td className="px-3 py-2.5 align-middle">
                            {s.status === "sent" ? (
                              <span className={pillSent}>Sent</span>
                            ) : (
                              <span className={`${pillFailed} cursor-help`} title={s.error || ""}>
                                Failed
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 align-middle">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDelete(s);
                              }}
                              disabled={deletingId === s.id}
                              title="Delete from history"
                              aria-label="Delete from history"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-red-50 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {deletingId === s.id ? "…" : "🗑"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <Pagination
                  page={currentPage}
                  pageCount={pageCount}
                  total={filtered.length}
                  pageSize={PAGE_SIZE}
                  onChange={setPage}
                  label="emails"
                />
              </div>
            )}
          </div>
        </section>
      </main>

      {/* Full-email viewer */}
      {viewing && (
        <div
          className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm"
          onClick={() => setViewing(null)}
        >
          <div
            className="my-8 w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-slate-900">
                    {viewing.name || viewing.email}
                  </h2>
                  {viewing.apollo_id === "demo" && (
                    <span className="rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-800">
                      Demo
                    </span>
                  )}
                  {viewing.status === "sent" ? (
                    <span className={pillSent}>Sent</span>
                  ) : (
                    <span className={pillFailed}>Failed</span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  {viewing.email}
                  {viewing.company ? ` · ${viewing.company}` : ""} · {formatWhen(viewing.sent_at)}
                </p>
              </div>
              <button
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                onClick={() => setViewing(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 p-5">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-400">Subject</div>
                <div className="font-medium text-slate-900">{viewing.subject}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-400">Body</div>
                {viewing.body ? (
                  <div className="mt-1 max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed text-slate-700">
                    {viewing.body}
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-slate-400">
                    No body stored for this send (logged before the body column existed).
                  </p>
                )}
              </div>
              {viewing.status !== "sent" && viewing.error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  <span className="font-semibold">Error:</span> {viewing.error}
                </div>
              )}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600 sm:grid-cols-3">
                <span>
                  <span className="text-slate-400">Campaign:</span>{" "}
                  {viewing.campaign_name || <span className="text-slate-400">— (one-off send)</span>}
                </span>
                <span>
                  <span className="text-slate-400">Step:</span>{" "}
                  {viewing.step_number == null
                    ? "—"
                    : viewing.step_number === 1
                    ? "Initial email"
                    : `Follow-up ${viewing.step_number - 1}`}
                </span>
                <span>
                  <span className="text-slate-400">Template:</span> {viewing.template_name || "—"}
                </span>
                <span className="col-span-2 sm:col-span-3">
                  <span className="text-slate-400">Delivery:</span> {deliveryLabel(viewing)}
                </span>
                {viewing.message_id && (
                  <span className="col-span-2 max-w-full truncate sm:col-span-3">
                    <span className="text-slate-400">Message-id:</span> {viewing.message_id}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Human-readable delivery trail from the stamped event columns.
function deliveryLabel(v) {
  const parts = [];
  parts.push(v.status === "sent" ? "accepted by Brevo" : "send failed");
  if (v.opened_at) parts.push("opened");
  if (v.clicked_at) parts.push("clicked");
  if (v.bounced_at) parts.push("bounced");
  if (v.complained_at) parts.push("spam complaint");
  return parts.join(" · ");
}

function formatWhen(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
