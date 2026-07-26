"use client";

// Role-based home: patients land on their Today view (build step 4); PTs and
// admins without a patient role see the stack-check + a pointer to /patients,
// their real home surface (reachable from the nav either way).

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { useAuth } from "@/components/AuthContext";
import PatientToday from "@/components/PatientToday";

type Membership = { clinicId: string; clinicName: string; role: string };
type Bootstrap = {
  user: {
    id: string;
    litheUserId: string;
    email: string;
    displayName: string;
    isAppAdmin: boolean;
  };
  memberships: Membership[];
};

export default function Home() {
  const { enabled, loading, session } = useAuth();
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (enabled && !session) return; // RequireAuth shows the login screen
    let alive = true;
    apiFetch("/api/bootstrap", { method: "POST" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`bootstrap ${res.status}`);
        return (await res.json()) as Bootstrap;
      })
      .then((b) => alive && setBoot(b))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [enabled, loading, session]);

  if (boot?.memberships.some((m) => m.role === "patient")) {
    return <PatientToday />;
  }

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-3xl font-extrabold tracking-tight">
          <span className="brand-text">Carryover</span>
        </h1>
        <p className="mt-2 max-w-xl text-muted">
          Your PT&apos;s plan, always with you.{" "}
          {boot?.memberships.length ? (
            <>
              Head to <Link href="/patients" className="underline">Patients</Link> to draft and
              approve plans.
            </>
          ) : (
            "This is the walking skeleton — the stack is live end-to-end; the product lands on top of it."
          )}
        </p>
      </section>

      <section className="rounded-xl border border-edge bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Stack check
        </h2>
        {error ? (
          <p className="mt-3 text-sm text-flag">
            Bootstrap failed: {error}
            {!enabled && (
              <span className="block text-muted">
                Standalone mode — is the dev DB up and CARRYOVER_ALLOW_DEV_USER
                set in .env?
              </span>
            )}
          </p>
        ) : !boot ? (
          <p className="mt-3 text-sm text-muted">Bootstrapping…</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            <li>
              <span className="text-accent-deep">✓</span> Database migrated at
              boot, bootstrap round-trip OK
            </li>
            <li>
              <span className="text-accent-deep">✓</span> Signed in as{" "}
              <strong>{boot.user.displayName || boot.user.email || boot.user.litheUserId}</strong>
              {boot.user.isAppAdmin && (
                <span className="ml-2 rounded-full bg-raise px-2 py-0.5 text-xs">
                  app admin
                </span>
              )}
              {!enabled && (
                <span className="ml-2 rounded-full bg-raise px-2 py-0.5 text-xs">
                  standalone dev user
                </span>
              )}
            </li>
            <li>
              {boot.memberships.length ? (
                <>
                  <span className="text-accent-deep">✓</span> Clinic roles:{" "}
                  {boot.memberships
                    .map((m) => `${m.role} @ ${m.clinicName}`)
                    .join(", ")}
                </>
              ) : (
                <>
                  <span className="text-muted">○</span>{" "}
                  <span className="text-muted">
                    No clinic membership yet — clinics, roles, and PT↔patient
                    assignment arrive in build step 2.
                  </span>
                </>
              )}
            </li>
          </ul>
        )}
      </section>

    </div>
  );
}
