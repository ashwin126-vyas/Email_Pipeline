// Shared Tailwind class bundles, reused across the recipients and sends pages.

export const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50";

export const btnGhost =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-50";

export const btnGhostSm =
  "inline-flex items-center justify-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-50";

export const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30";

export const labelCls =
  "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500";

export const codeCls =
  "rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-700";

// Header tab / nav link (top-right).
export const tabLink =
  "inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700";

// Status pills.
export const pillSent =
  "inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700";
export const pillFailed =
  "inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700";

// Table cell / header (centered across the app, per the shared table style).
export const thCls =
  "px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-500";
export const tdCls = "px-3 py-2.5 text-center align-middle";
