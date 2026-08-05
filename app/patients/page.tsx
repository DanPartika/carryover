"use client";

// PT home base (PRD build step 3): assigned patients with episode/plan status.
// Clinic admins see all patients in their clinics.

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { useAuth } from "@/components/AuthContext";

type Row = {
  id: string;
  display_name: string | null;
  email: string | null;
  clinicId: string;
  clinicName: string;
  episodeId: string | null;
  condition: string | null;
  planStatus: "draft" | "active" | null;
  flagCount: number;
  lastLoggedOn: string | null;
  reviewDue: boolean;
  reviewLine: string;
};

const QUIET_AFTER_DAYS = 4;

/** Days a patient with an active plan has gone without logging, or null when
 *  they're current (or have no plan to be behind on). Silence is the signal a
 *  PT most often misses between visits — it earns a chip of its own. */
function quietDays(row: Row, today: string | null): number | null {
  if (!today || row.planStatus !== "active") return null;
  if (!row.lastLoggedOn) return null; // "never logged" is its own chip below
  const n = Math.round((Date.parse(today) - Date.parse(row.lastLoggedOn)) / 86_400_000);
  return n >= QUIET_AFTER_DAYS ? n : null;
}

function StatusChip({ row }: { row: Row }) {
  if (row.planStatus === "active")
    return (
      <span className="rounded-full bg-accent-deep px-2.5 py-0.5 text-xs font-medium text-white">
        active plan
      </span>
    );
  if (row.planStatus === "draft")
    return (
      <span className="rounded-full bg-[var(--color-clinic)] px-2.5 py-0.5 text-xs font-medium text-white">
        draft plan
      </span>
    );
  if (row.episodeId)
    return (
      <span className="rounded-full bg-raise px-2.5 py-0.5 text-xs text-muted">intake done</span>
    );
  return (
    <span className="rounded-full bg-raise px-2.5 py-0.5 text-xs text-muted">needs intake</span>
  );
}

/** Attention chips: what the PT should look at before opening the patient. */
function AttentionChips({ row, today }: { row: Row; today: string | null }) {
  const quiet = quietDays(row, today);
  const neverLogged = row.planStatus === "active" && !row.lastLoggedOn;
  return (
    <>
      {row.flagCount > 0 && (
        <span className="rounded-full bg-flag px-2.5 py-0.5 text-xs font-medium text-white">
          ⚑ {row.flagCount}
        </span>
      )}
      {/* One chip for all four check-in triggers, never four badges. The
          reason lives in the tooltip and in full on the patient page — a list
          is for deciding who to open, not for reading the numbers. */}
      {row.reviewDue && (
        <span
          title={row.reviewLine}
          className="rounded-full border border-accent-deep px-2.5 py-0.5 text-xs font-medium text-accent-deep"
        >
          review due
        </span>
      )}
      {neverLogged && (
        <span className="rounded-full border border-flag/40 px-2.5 py-0.5 text-xs text-flag">
          never logged
        </span>
      )}
      {quiet !== null && (
        <span className="rounded-full border border-edge px-2.5 py-0.5 text-xs text-muted">
          quiet {quiet}d
        </span>
      )}
    </>
  );
}

export default function PatientsPage() {
  const { enabled, loading, session } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const authReady = !loading && (!enabled || !!session);

  useEffect(() => {
    if (!authReady) return;
    apiFetch("/api/patients")
      .then(async (res) => {
        if (!res.ok) throw new Error(`patients ${res.status}`);
        const data = (await res.json()) as { patients: Row[]; today: string };
        setRows(data.patients);
        setToday(data.today);
      })
      .catch((e) => setError((e as Error).message));
  }, [authReady]);

  if (!authReady) return null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Patients</h1>
        <p className="text-sm text-muted">
          Your assigned patients. Assignments are managed on the People page.
        </p>
      </div>
      {error && <p className="text-sm text-flag">Failed to load: {error}</p>}
      {rows && rows.length === 0 && (
        <p className="rounded-xl border border-edge bg-card p-5 text-sm text-muted">
          No patients assigned to you yet — add an assignment under People.
        </p>
      )}
      <ul className="space-y-2">
        {rows?.map((r) => (
          <li key={`${r.clinicId}:${r.id}`}>
            <Link
              href={`/patients/${r.id}?clinic=${r.clinicId}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-edge bg-card px-4 py-3 transition hover:border-accent"
            >
              <span>
                <span className="text-sm font-semibold">
                  {r.display_name || r.email || "Unnamed patient"}
                </span>
                {r.condition && (
                  <span className="ml-2 text-xs text-muted">{r.condition}</span>
                )}
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <AttentionChips row={r} today={today} />
                <StatusChip row={r} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
