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
};

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

export default function PatientsPage() {
  const { enabled, loading, session } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const authReady = !loading && (!enabled || !!session);

  useEffect(() => {
    if (!authReady) return;
    apiFetch("/api/patients")
      .then(async (res) => {
        if (!res.ok) throw new Error(`patients ${res.status}`);
        const data = (await res.json()) as { patients: Row[] };
        setRows(data.patients);
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
              <StatusChip row={r} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
