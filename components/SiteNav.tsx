"use client";

// The header nav, finally role-aware: Patients / Library / People are the
// clinician's workbench, and a patient scanning for their exercises should
// never have to learn which links aren't for them. Patient-only accounts (and
// logged-out visitors) get just the brand and the account chip.

import Link from "next/link";
import { AccountControl } from "@/components/AuthContext";
import { useBootstrap } from "@/components/Bootstrap";

const LINKS: [href: string, label: string][] = [
  ["/patients", "Patients"],
  ["/library", "Library"],
  ["/people", "People"],
];

export default function SiteNav() {
  const { isStaff } = useBootstrap();
  return (
    <nav className="flex items-center gap-4">
      {isStaff &&
        LINKS.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className="text-sm font-semibold text-muted transition hover:text-ink"
          >
            {label}
          </Link>
        ))}
      <AccountControl />
    </nav>
  );
}
