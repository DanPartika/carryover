"use client";

// People management (PRD build step 2): clinic creation (app admin), member
// roles, and the many-to-many PT↔patient assignment. PT/admin only — patients
// get a friendly redirect card. Inviting someone brand-new happens in Lithe
// (Studio invite → they log in here once → they appear under "Add person").

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { useAuth } from "@/components/AuthContext";

type Membership = { clinicId: string; clinicName: string; role: string };
type Bootstrap = {
  user: { id: string; displayName: string; email: string; isAppAdmin: boolean };
  memberships: Membership[];
};
type Member = { id: string; display_name: string | null; email: string | null; roles: string[] };
type Assignment = {
  ptUserId: string;
  ptName: string | null;
  patientUserId: string;
  patientName: string | null;
  patientEmail: string | null;
};
type Candidate = { id: string; display_name: string | null; email: string | null };
type People = { members: Member[]; assignments: Assignment[]; candidates: Candidate[] };

const ROLE_STYLES: Record<string, string> = {
  pt: "bg-[var(--color-clinic)] text-white",
  patient: "bg-accent-deep text-white",
  admin: "bg-ink text-white",
};

function personLabel(p: { display_name: string | null; email: string | null }): string {
  return p.display_name || p.email || "Unnamed user";
}

export default function PeoplePage() {
  const { enabled, loading, session } = useAuth();
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [people, setPeople] = useState<People | null>(null);
  const [clinicId, setClinicId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newClinic, setNewClinic] = useState("");
  const [addUser, setAddUser] = useState("");
  const [addRole, setAddRole] = useState("patient");
  const [assignPt, setAssignPt] = useState("");
  const [assignPatient, setAssignPatient] = useState("");

  const authReady = !loading && (!enabled || !!session);

  const loadPeople = useCallback(async (cid: string) => {
    const res = await apiFetch(`/api/clinics/${cid}/people`);
    if (res.status === 403) {
      setPeople(null);
      return;
    }
    if (!res.ok) throw new Error(`people ${res.status}`);
    setPeople((await res.json()) as People);
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      const res = await apiFetch("/api/bootstrap", { method: "POST" });
      if (!res.ok) throw new Error(`bootstrap ${res.status}`);
      const b = (await res.json()) as Bootstrap;
      setBoot(b);
      const manageable = b.memberships.find((m) => m.role === "pt" || m.role === "admin");
      const cid = manageable?.clinicId ?? b.memberships[0]?.clinicId ?? null;
      setClinicId(cid);
      if (manageable) await loadPeople(manageable.clinicId);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [loadPeople]);

  useEffect(() => {
    if (authReady) void bootstrap();
  }, [authReady, bootstrap]);

  async function act(body: Record<string, string>) {
    if (!clinicId) return;
    setError(null);
    const res = await apiFetch(`/api/clinics/${clinicId}/people`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? `action failed (${res.status})`);
      return;
    }
    await loadPeople(clinicId);
  }

  async function createClinic() {
    const name = newClinic.trim();
    if (!name) return;
    setError(null);
    const res = await apiFetch("/api/clinics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      setError(`clinic creation failed (${res.status})`);
      return;
    }
    setNewClinic("");
    await bootstrap();
  }

  if (!authReady || !boot) {
    return <p className="py-10 text-center text-sm text-muted">{error ?? "Loading…"}</p>;
  }

  const manages = boot.memberships.some((m) => m.role === "pt" || m.role === "admin");

  // No clinic yet: app admin creates it; everyone else waits for a role.
  if (!manages) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-8">
        <h1 className="text-2xl font-extrabold tracking-tight">People</h1>
        {boot.memberships.length > 0 ? (
          <p className="text-sm text-muted">
            You&apos;re set up as a <strong>{boot.memberships[0].role}</strong> at{" "}
            <strong>{boot.memberships[0].clinicName}</strong>. Your program lives on the home
            screen — people management is for PTs and clinic admins.
          </p>
        ) : boot.user.isAppAdmin ? (
          <div className="rounded-xl border border-edge bg-card p-5">
            <h2 className="font-semibold">Create your clinic</h2>
            <p className="mt-1 text-sm text-muted">
              The clinic is the container for PTs, patients, and assignments.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                value={newClinic}
                onChange={(e) => setNewClinic(e.target.value)}
                placeholder="Clinic name"
                className="flex-1 rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <button
                onClick={() => void createClinic()}
                className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
              >
                Create
              </button>
            </div>
            {error && <p className="mt-2 text-sm text-flag">{error}</p>}
          </div>
        ) : (
          <p className="text-sm text-muted">
            You don&apos;t belong to a clinic yet — ask your PT or clinic admin to add you.
          </p>
        )}
      </div>
    );
  }

  const clinicName =
    boot.memberships.find((m) => m.clinicId === clinicId)?.clinicName ?? "Clinic";
  const pts = people?.members.filter((m) => m.roles.includes("pt")) ?? [];
  const patients = people?.members.filter((m) => m.roles.includes("patient")) ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">{clinicName} — people</h1>
        <p className="text-sm text-muted">
          Roles and PT↔patient assignments. New people are invited through Lithe; once
          they&apos;ve logged in here, they appear under “Add person.”
        </p>
      </div>

      {error && <p className="text-sm text-flag">{error}</p>}

      <section className="rounded-xl border border-edge bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Members</h2>
        <ul className="mt-3 divide-y divide-edge">
          {people?.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <div className="min-w-40 flex-1">
                <div className="text-sm font-semibold">{personLabel(m)}</div>
                {m.email && <div className="text-xs text-muted">{m.email}</div>}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {m.roles.map((r) => (
                  <span
                    key={r}
                    className={`group inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${ROLE_STYLES[r] ?? "bg-raise"}`}
                  >
                    {r}
                    <button
                      onClick={() => void act({ action: "remove_member", userId: m.id, role: r })}
                      className="opacity-60 hover:opacity-100"
                      title={`Remove ${r} role`}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value)
                      void act({ action: "add_member", userId: m.id, role: e.target.value });
                  }}
                  className="rounded-full border border-edge bg-card px-2 py-0.5 text-xs text-muted"
                >
                  <option value="">+ role</option>
                  {["pt", "patient", "admin"]
                    .filter((r) => !m.roles.includes(r))
                    .map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                </select>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-edge pt-4">
          <select
            value={addUser}
            onChange={(e) => setAddUser(e.target.value)}
            className="min-w-48 flex-1 rounded-lg border border-edge bg-card px-2 py-2 text-sm"
          >
            <option value="">Add person (has logged in before)…</option>
            {people?.candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {personLabel(c)}
              </option>
            ))}
          </select>
          <select
            value={addRole}
            onChange={(e) => setAddRole(e.target.value)}
            className="rounded-lg border border-edge bg-card px-2 py-2 text-sm"
          >
            <option value="patient">patient</option>
            <option value="pt">pt</option>
            <option value="admin">admin</option>
          </select>
          <button
            onClick={() => {
              if (addUser) {
                void act({ action: "add_member", userId: addUser, role: addRole });
                setAddUser("");
              }
            }}
            disabled={!addUser}
            className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            Add
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-edge bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          PT ↔ patient assignments
        </h2>
        <ul className="mt-3 space-y-1.5">
          {people?.assignments.length === 0 && (
            <li className="text-sm text-muted">No assignments yet.</li>
          )}
          {people?.assignments.map((a) => (
            <li
              key={`${a.ptUserId}:${a.patientUserId}`}
              className="flex items-center justify-between gap-2 rounded-lg bg-raise/60 px-3 py-2 text-sm"
            >
              <span>
                <strong>{a.ptName ?? "PT"}</strong>
                <span className="text-muted"> treats </span>
                <strong>{a.patientName ?? a.patientEmail ?? "patient"}</strong>
              </span>
              <button
                onClick={() =>
                  void act({
                    action: "unassign",
                    ptUserId: a.ptUserId,
                    patientUserId: a.patientUserId,
                  })
                }
                className="text-xs text-muted hover:text-flag"
              >
                remove
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-edge pt-4">
          <select
            value={assignPt}
            onChange={(e) => setAssignPt(e.target.value)}
            className="min-w-40 flex-1 rounded-lg border border-edge bg-card px-2 py-2 text-sm"
          >
            <option value="">PT…</option>
            {pts.map((m) => (
              <option key={m.id} value={m.id}>
                {personLabel(m)}
              </option>
            ))}
          </select>
          <span className="text-sm text-muted">treats</span>
          <select
            value={assignPatient}
            onChange={(e) => setAssignPatient(e.target.value)}
            className="min-w-40 flex-1 rounded-lg border border-edge bg-card px-2 py-2 text-sm"
          >
            <option value="">Patient…</option>
            {patients.map((m) => (
              <option key={m.id} value={m.id}>
                {personLabel(m)}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              if (assignPt && assignPatient) {
                void act({ action: "assign", ptUserId: assignPt, patientUserId: assignPatient });
                setAssignPt("");
                setAssignPatient("");
              }
            }}
            disabled={!assignPt || !assignPatient}
            className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            Assign
          </button>
        </div>
      </section>
    </div>
  );
}
