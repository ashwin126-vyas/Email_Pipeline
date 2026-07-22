"use client";

// Shared sticky app header used by every page: a consistent brand mark that
// links home, active-highlighted nav tabs, and a per-page `actions` slot on the
// right. Keeps navigation identical across Recipients / Campaigns / Sent so the
// app reads as one product.

import Link from "next/link";
import { tabLink, tabLinkActive } from "@/lib/ui";

const NAV = [
  { key: "recipients", href: "/", label: "Recipients", icon: "✉" },
  { key: "campaigns", href: "/campaigns", label: "Campaigns", icon: "🤖" },
  { key: "sends", href: "/sends", label: "Sent", icon: "📤" },
];

export default function AppHeader({ active, subtitle, actions, width = "max-w-6xl" }) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className={`mx-auto flex ${width} flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3`}>
        <Link href="/" className="mr-auto flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-blue-600 text-base text-white shadow-sm">
            ✉
          </span>
          <span className="leading-tight">
            <span className="block text-[15px] font-bold text-slate-900">Brevo Email Pipeline</span>
            {subtitle && <span className="block text-[11px] text-slate-500">{subtitle}</span>}
          </span>
        </Link>

        <nav className="flex items-center gap-1.5">
          {NAV.map((n) => (
            <Link
              key={n.key}
              href={n.href}
              className={n.key === active ? tabLinkActive : tabLink}
              aria-current={n.key === active ? "page" : undefined}
            >
              <span aria-hidden>{n.icon}</span>
              <span className="hidden sm:inline">{n.label}</span>
            </Link>
          ))}
        </nav>

        {actions}
      </div>
    </header>
  );
}
