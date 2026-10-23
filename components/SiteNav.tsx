"use client";

// The header nav, finally role-aware: Patients / Library / People are the
// clinician's workbench, and a patient scanning for their exercises should
// never have to learn which links aren't for them. A patient gets the one
// link that is for them — the library, read-only, so they can look up how to
// do any exercise — and logged-out visitors get just the brand and the
// account chip.

import Link from "next/link";
import { AccountControl } from "@/components/AuthContext";
import { useBootstrap } from "@/components/Bootstrap";

const STAFF_LINKS: [href: string, label: string][] = [
  ["/patients", "Patients"],
  ["/library", "Library"],
  ["/people", "People"],
];
const PATIENT_LINKS: [href: string, label: string][] = [["/library", "Library"]];

export default function SiteNav() {
  const { boot, isStaff } = useBootstrap();
  const isPatient = !!boot?.memberships.some((m) => m.role === "patient");
  const links = isStaff ? STAFF_LINKS : isPatient ? PATIENT_LINKS : [];
  return (
    <nav className="flex items-center gap-4">
      {links.map(([href, label]) => (
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
