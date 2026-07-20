"use client";

// Compact pager: "Showing X–Y of Z" + First/Prev, numbered pages (with ellipsis
// when there are many), Next/Last. Purely presentational — parent owns `page`.

function pageWindow(page, pageCount) {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const pages = [1];
  if (page > 3) pages.push("…");
  const start = Math.max(2, page - 1);
  const end = Math.min(pageCount - 1, page + 1);
  for (let i = start; i <= end; i++) pages.push(i);
  if (page < pageCount - 2) pages.push("…");
  pages.push(pageCount);
  return pages;
}

export default function Pagination({ page, pageCount, total, pageSize, onChange, label = "records" }) {
  if (total === 0) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const go = (p) => onChange(Math.min(Math.max(1, p), pageCount));

  const numBtn =
    "grid h-8 min-w-8 place-items-center rounded-md border px-2 text-sm font-medium transition";
  const arrow =
    "grid h-8 min-w-8 place-items-center rounded-md border border-slate-300 bg-white text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
      <p className="text-xs text-slate-500">
        Showing <span className="font-semibold text-slate-700">{from}</span>–
        <span className="font-semibold text-slate-700">{to}</span> of{" "}
        <span className="font-semibold text-slate-700">{total}</span> {label}
      </p>

      <div className="flex items-center gap-1">
        <button className={arrow} onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Previous page">
          ‹
        </button>

        {pageWindow(page, pageCount).map((p, i) =>
          p === "…" ? (
            <span key={`e${i}`} className="px-1.5 text-slate-400">
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => go(p)}
              className={
                p === page
                  ? `${numBtn} border-blue-600 bg-blue-600 text-white`
                  : `${numBtn} border-slate-300 bg-white text-slate-700 hover:bg-slate-50`
              }
              aria-current={p === page ? "page" : undefined}
            >
              {p}
            </button>
          )
        )}

        <button className={arrow} onClick={() => go(page + 1)} disabled={page >= pageCount} aria-label="Next page">
          ›
        </button>
      </div>
    </div>
  );
}
