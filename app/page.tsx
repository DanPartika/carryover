"use client";

// Role-based home: patients land on their Today view (build step 4); PTs and
// admins without a patient role see the stack-check + a pointer to /patients,
// their real home surface (reachable from the nav either way).

import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { useAuth } from "@/components/AuthContext";
import { useBootstrap, type Bootstrap } from "@/components/Bootstrap";
import PatientToday from "@/components/PatientToday";

export default function Home() {
  const { enabled } = useAuth();
  // Shared with the nav — one fetch per page load, and "refresh" re-reads the
  // setup guide's preconditions after it changes membership.
  const { boot, error, refresh } = useBootstrap();

  if (boot?.memberships.some((m) => m.role === "patient")) {
    return <PatientToday />;
  }

  const hasClinic = (boot?.memberships.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-3xl font-extrabold tracking-tight">
          <span className="brand-text">Carryover</span>
        </h1>
        <p className="mt-2 max-w-xl text-muted">
          {hasClinic ? (
            <>
              Head to <Link href="/patients" className="underline">Patients</Link> to draft and
              approve plans, run a visit, or check who&apos;s fallen behind.
            </>
          ) : (
            "Home exercise programs your patients actually finish — drafted in a minute, tracked between visits."
          )}
        </p>
      </section>

      {error ? (
        <section className="rounded-xl border border-edge bg-card p-5">
          <p className="text-sm text-flag">
            Bootstrap failed: {error}
            {!enabled && (
              <span className="block text-muted">
                Standalone mode — is the dev DB up and CARRYOVER_ALLOW_DEV_USER set in .env?
              </span>
            )}
          </p>
        </section>
      ) : !boot ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <SetupGuide boot={boot} onChanged={refresh} />
      )}
    </div>
  );
}

/** First-run path (PRD build step 7 onboarding pass, doctrine #2: a PT should
 *  be running in under five minutes). Three steps, each one either done or the
 *  only thing on screen to do next — no hunting through nav for the entry
 *  point, and no dead end for a PT whose admin hasn't set up the clinic. */
function SetupGuide({ boot, onChanged }: { boot: Bootstrap; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasClinic = boot.memberships.length > 0;

  async function createClinic() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/clinics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        setError(`could not create the clinic (${res.status})`);
        return;
      }
      setName("");
      onChanged();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  if (hasClinic) {
    return (
      <section className="rounded-xl border border-edge bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Your clinics</h2>
        <ul className="mt-3 space-y-1 text-sm">
          {boot.memberships.map((m) => (
            <li key={`${m.clinicId}:${m.role}`}>
              <span className="text-accent-deep">✓</span> {m.role} @ {m.clinicName}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/patients"
            className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            Patients
          </Link>
          <Link
            href="/people"
            className="rounded-lg border border-edge px-4 py-2 text-sm font-medium hover:bg-raise"
          >
            People &amp; assignments
          </Link>
          <Link
            href="/library"
            className="rounded-lg border border-edge px-4 py-2 text-sm font-medium hover:bg-raise"
          >
            Exercise library
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-edge bg-card p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Get set up</h2>
      <ol className="mt-3 space-y-4 text-sm">
        <li>
          <p className="font-medium">1. Create your clinic</p>
          {boot.user.isAppAdmin ? (
            <>
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Clinic name"
                  className="min-w-48 flex-1 rounded-lg border border-edge bg-card px-3 py-2 outline-none focus:border-accent"
                />
                <button
                  onClick={() => void createClinic()}
                  disabled={busy || !name.trim()}
                  className="rounded-lg bg-accent-deep px-4 py-2 font-semibold text-white hover:brightness-110 disabled:opacity-40"
                >
                  {busy ? "Creating…" : "Create"}
                </button>
              </div>
              {error && <p className="mt-2 text-flag">{error}</p>}
            </>
          ) : (
            <p className="mt-1 text-muted">
              Ask whoever administers Carryover to create the clinic and add you as a PT — your
              account can&apos;t create one.
            </p>
          )}
        </li>
        <li className="text-muted">
          <p className="font-medium">2. Add your people</p>
          <p className="mt-1">
            Anyone who has logged into Carryover once can be given a role and assigned to you.
          </p>
        </li>
        <li className="text-muted">
          <p className="font-medium">3. Open a patient and run an intake</p>
          <p className="mt-1">
            The AI drafts a plan from your library; nothing reaches the patient until you approve
            it.
          </p>
        </li>
      </ol>
    </section>
  );
}
