"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Pagination from "@/components/Pagination";
import { tabLink, btnGhostSm, pillSent, pillFailed, thCls } from "@/lib/ui";

const PAGE_SIZE = 10;

export default function SendsPage() {
  const [sends, setSends] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("all"); // all | sent | failed

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
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-3">
          <div className="mr-auto">
            <h1 className="flex items-center gap-2 text-lg font-bold text-slate-900">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-blue-600 text-sm text-white">
                📤
              </span>
              Emailed Send
            </h1>
            <p className="mt-0.5 text-xs text-slate-500">
              Every email sent through Brevo — successes and failures — newest first.
            </p>
          </div>
          <Link href="/" className={tabLink}>
            <span>←</span> Recipients
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-6">
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
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {pageItems.map((s, i) => (
                        <tr key={s.id} className="hover:bg-slate-50">
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
    </div>
  );
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
