"use client";

// The PT's patient page (PRD build step 3, the wow demo): intake → "Draft with
// AI" → edit the draft → approve. Approved plans are read-only; a new draft
// replaces the active plan only at the moment of approval.

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import { useAuth } from "@/components/AuthContext";

const REGION_OPTIONS = [
  ["knee", "Knee"],
  ["hip", "Hip"],
  ["ankle_foot", "Ankle/foot"],
  ["spine", "Spine"],
  ["core", "Core"],
  ["shoulder", "Shoulder"],
  ["elbow", "Elbow"],
  ["wrist_hand", "Wrist/hand"],
  ["neck", "Neck"],
] as const;

type Intake = {
  id: string;
  condition: string;
  bodyRegions: string[];
  onsetDate: string | null;
  painNow: number | null;
  painWorst: number | null;
  goals: string | null;
  restrictions: string | null;
  narrative: string | null;
  createdAt: string;
};

type Item = {
  id?: string;
  exerciseId: string;
  name: string;
  image: string | null;
  sets: number | null;
  reps: number | null;
  holdSecs: number | null;
  frequencyPerWeek: number;
  location: "office" | "home" | "both";
  rationale: string | null;
};

type Plan = {
  id: string;
  status: "draft" | "active";
  source: string;
  model: string | null;
  createdAt: string;
  approvedAt: string | null;
  items: Item[];
};

type Overview = {
  patient: { id: string; displayName: string | null; email: string | null };
  equipment: string[];
  episode: { id: string; condition: string } | null;
  latestIntake: Intake | null;
  plans: Plan[];
};

type SearchHit = { id: string; name: string; difficulty: number | null };

export default function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: patientId } = use(params);
  const clinicId = useSearchParams().get("clinic") ?? "";
  const { enabled, loading, session } = useAuth();
  const authReady = !loading && (!enabled || !!session);

  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Intake form state
  const [showIntake, setShowIntake] = useState(false);
  const [condition, setCondition] = useState("");
  const [regions, setRegions] = useState<string[]>(["knee"]);
  const [onsetDate, setOnsetDate] = useState("");
  const [painNow, setPainNow] = useState("5");
  const [painWorst, setPainWorst] = useState("7");
  const [goals, setGoals] = useState("");
  const [restrictions, setRestrictions] = useState("");
  const [narrative, setNarrative] = useState("");

  // Draft editor state (mirrors the draft plan's items)
  const [draftItems, setDraftItems] = useState<Item[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/patients/${patientId}/overview?clinicId=${clinicId}`);
      if (!res.ok) {
        setError(`load failed (${res.status})`);
        return;
      }
      const d = (await res.json()) as Overview;
      setData(d);
      const draft = d.plans.find((p) => p.status === "draft");
      setDraftItems(draft ? draft.items.map((i) => ({ ...i })) : null);
      setDirty(false);
    } catch {
      setError("network error — reload the page");
    }
  }, [patientId, clinicId]);

  useEffect(() => {
    // All setState inside reload() happens after awaits (async), not in the
    // effect body — the compiler lint can't see through the useCallback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (authReady && clinicId) void reload();
  }, [authReady, clinicId, reload]);

  // Exercise search for the editor's add row. All setState happens inside the
  // debounce callback (async), never in the effect body itself.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = search.trim();
    searchTimer.current = setTimeout(
      async () => {
        if (!q) {
          setHits([]);
          return;
        }
        const res = await apiFetch(`/api/exercises?q=${encodeURIComponent(q)}&limit=8`);
        if (res.ok) {
          const d = (await res.json()) as { items: SearchHit[] };
          setHits(d.items);
        }
      },
      q ? 250 : 0,
    );
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search]);

  async function submitIntake() {
    // The post-intake reload rebuilds the draft editor from the server —
    // unsaved draft edits must land first (same contract as approve()).
    if (dirty && !(await saveDraft())) return;
    setBusy("intake");
    setError(null);
    try {
      const res = await apiFetch("/api/intakes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clinicId,
          patientUserId: patientId,
          condition,
          bodyRegions: regions,
          onsetDate: onsetDate || null,
          painNow: painNow === "" ? null : Number(painNow),
          painWorst: painWorst === "" ? null : Number(painWorst),
          goals,
          restrictions,
          narrative,
        }),
      });
      if (!res.ok) {
        setError(`intake failed (${res.status})`);
        return;
      }
      setShowIntake(false);
      await reload();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(null);
    }
  }

  async function draftWithAi() {
    if (!data?.episode) return;
    setBusy("draft");
    setError(null);
    try {
      const res = await apiFetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeId: data.episode.id, source: "ai-draft" }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `draft failed (${res.status})`);
        return;
      }
      await reload();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(null);
    }
  }

  const draftPlanId = data?.plans.find((p) => p.status === "draft")?.id;

  async function saveDraft(): Promise<boolean> {
    if (!draftPlanId || !draftItems) return false;
    setBusy("save");
    try {
      const res = await apiFetch(`/api/plans/${draftPlanId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: draftItems.map((i) => ({
            exerciseId: i.exerciseId,
            sets: i.sets,
            reps: i.reps,
            holdSecs: i.holdSecs,
            frequencyPerWeek: i.frequencyPerWeek,
            location: i.location,
            rationale: i.rationale,
          })),
        }),
      });
      if (!res.ok) {
        setError(`save failed (${res.status})`);
        return false;
      }
      // The editor is disabled while busy (fieldset), so no edits can have
      // landed since the snapshot above — clearing dirty is safe.
      setDirty(false);
      return true;
    } catch {
      setError("network error — try again");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (!draftPlanId) return;
    if (dirty && !(await saveDraft())) return;
    setBusy("approve");
    try {
      const res = await apiFetch(`/api/plans/${draftPlanId}/approve`, { method: "POST" });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `approve failed (${res.status})`);
        return;
      }
      await reload();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(null);
    }
  }

  async function discardDraft() {
    if (!draftPlanId) return;
    setBusy("discard");
    try {
      await apiFetch(`/api/plans/${draftPlanId}`, { method: "DELETE" });
      await reload();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(null);
    }
  }

  function updateItem(idx: number, patch: Partial<Item>) {
    setDraftItems((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
    setDirty(true);
  }

  // Mirror the server's clampOrNull bounds so what the editor shows is what
  // gets stored — HTML min/max doesn't constrain typed values.
  function boundedOrNull(v: string, lo: number, hi: number): number | null {
    if (v === "") return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return null;
    return Math.min(Math.max(n, lo), hi);
  }

  if (!authReady) return null;
  if (!clinicId) return <p className="py-10 text-center text-sm text-flag">Missing clinic id.</p>;
  if (!data) {
    return <p className="py-10 text-center text-sm text-muted">{error ?? "Loading…"}</p>;
  }

  const activePlan = data.plans.find((p) => p.status === "active");
  const name = data.patient.displayName || data.patient.email || "Patient";

  const numInput =
    "w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center text-sm outline-none focus:border-accent";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">{name}</h1>
        <p className="text-sm text-muted">
          {data.episode ? data.episode.condition : "No open episode"} · home equipment:{" "}
          {data.equipment.length ? data.equipment.join(", ") : "none recorded"}
        </p>
      </div>

      {error && <p className="text-sm text-flag">{error}</p>}

      {/* Intake */}
      <section className="rounded-xl border border-edge bg-card p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Intake</h2>
          {!showIntake && (
            <button
              onClick={() => {
                if (data.latestIntake) {
                  const li = data.latestIntake;
                  setCondition(li.condition);
                  setRegions(li.bodyRegions);
                  setOnsetDate(li.onsetDate ?? "");
                  setPainNow(li.painNow?.toString() ?? "");
                  setPainWorst(li.painWorst?.toString() ?? "");
                  setGoals(li.goals ?? "");
                  setRestrictions(li.restrictions ?? "");
                  setNarrative(li.narrative ?? "");
                }
                setShowIntake(true);
              }}
              className="rounded-full border border-edge px-3 py-1 text-sm text-muted hover:bg-raise"
            >
              {data.latestIntake ? "New intake" : "Start intake"}
            </button>
          )}
        </div>

        {!showIntake && data.latestIntake && (
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">Condition</dt>
              <dd className="font-medium">{data.latestIntake.condition}</dd>
            </div>
            <div>
              <dt className="text-muted">Pain (now / worst)</dt>
              <dd className="font-medium">
                {data.latestIntake.painNow ?? "?"} / {data.latestIntake.painWorst ?? "?"}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Surgery/onset</dt>
              <dd className="font-medium">{data.latestIntake.onsetDate ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted">Restrictions</dt>
              <dd className="font-medium">{data.latestIntake.restrictions ?? "—"}</dd>
            </div>
            {data.latestIntake.goals && (
              <div className="sm:col-span-2">
                <dt className="text-muted">Goals</dt>
                <dd className="font-medium">{data.latestIntake.goals}</dd>
              </div>
            )}
          </dl>
        )}
        {!showIntake && !data.latestIntake && (
          <p className="mt-2 text-sm text-muted">
            No intake yet — it powers the AI draft and the library filtering.
          </p>
        )}

        {showIntake && (
          <div className="mt-3 space-y-3 text-sm">
            <input
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              placeholder="Condition / procedure (e.g. post-op ACL reconstruction, right knee)"
              className="w-full rounded-lg border border-edge bg-card px-3 py-2 outline-none focus:border-accent"
            />
            <div className="flex flex-wrap gap-2">
              {REGION_OPTIONS.map(([v, label]) => (
                <label
                  key={v}
                  className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${
                    regions.includes(v)
                      ? "border-accent-deep bg-accent-deep text-white"
                      : "border-edge text-muted"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="hidden"
                    checked={regions.includes(v)}
                    onChange={(e) =>
                      setRegions((prev) =>
                        e.target.checked ? [...prev, v] : prev.filter((r) => r !== v),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                <span className="text-muted">Surgery/onset</span>
                <input
                  type="date"
                  value={onsetDate}
                  onChange={(e) => setOnsetDate(e.target.value)}
                  className="rounded-lg border border-edge bg-card px-2 py-1.5"
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="text-muted">Pain now</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={painNow}
                  onChange={(e) => setPainNow(e.target.value)}
                  className={numInput}
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="text-muted">worst</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={painWorst}
                  onChange={(e) => setPainWorst(e.target.value)}
                  className={numInput}
                />
              </label>
            </div>
            <input
              value={goals}
              onChange={(e) => setGoals(e.target.value)}
              placeholder="Goals (return to running, stairs without pain…)"
              className="w-full rounded-lg border border-edge bg-card px-3 py-2 outline-none focus:border-accent"
            />
            <input
              value={restrictions}
              onChange={(e) => setRestrictions(e.target.value)}
              placeholder="Restrictions / precautions (weight-bearing status, ROM limits…)"
              className="w-full rounded-lg border border-edge bg-card px-3 py-2 outline-none focus:border-accent"
            />
            <textarea
              value={narrative}
              onChange={(e) => setNarrative(e.target.value)}
              placeholder="Narrative — anything the form missed"
              rows={3}
              className="w-full rounded-lg border border-edge bg-card px-3 py-2 outline-none focus:border-accent"
            />
            <div className="flex gap-2">
              <button
                onClick={() => void submitIntake()}
                disabled={!condition.trim() || busy === "intake"}
                className="rounded-lg bg-accent-deep px-4 py-2 font-semibold text-white hover:brightness-110 disabled:opacity-40"
              >
                {busy === "intake" ? "Saving…" : "Save intake"}
              </button>
              <button
                onClick={() => setShowIntake(false)}
                className="rounded-lg border border-edge px-4 py-2 text-muted hover:bg-raise"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Plan */}
      <section className="rounded-xl border border-edge bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Plan</h2>
          {!draftItems && data.latestIntake && (
            <button
              onClick={() => void draftWithAi()}
              disabled={busy === "draft"}
              className="rounded-full bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
            >
              {busy === "draft" ? "Drafting…" : activePlan ? "Draft a new plan with AI" : "✨ Draft with AI"}
            </button>
          )}
        </div>

        {/* Draft editor */}
        {draftItems && (
          <div className="mt-3 space-y-3">
            <p className="rounded-lg bg-raise/70 px-3 py-2 text-xs text-muted">
              {`Draft — nothing reaches ${name} until you approve. Edit dosage, swap or remove items, and rewrite any rationale (it's shown to the patient after approval).`}
            </p>
            {/* fieldset disables every control inside while a request is in
                flight — the save snapshot can never diverge from the screen */}
            <fieldset disabled={busy !== null} className="space-y-3">
            <ul className="space-y-2">
              {draftItems.map((it, idx) => (
                <li key={`${it.exerciseId}-${idx}`} className="rounded-lg border border-edge p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{it.name}</span>
                    <div className="flex items-center gap-2 text-xs">
                      <select
                        value={it.location}
                        onChange={(e) =>
                          updateItem(idx, { location: e.target.value as Item["location"] })
                        }
                        className="rounded-md border border-edge bg-card px-1.5 py-1"
                      >
                        <option value="home">home</option>
                        <option value="office">office</option>
                        <option value="both">both</option>
                      </select>
                      <button
                        onClick={() => {
                          setDraftItems((prev) => prev!.filter((_, i) => i !== idx));
                          setDirty(true);
                        }}
                        className="text-muted hover:text-flag"
                        title="Remove"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
                    <label className="flex items-center gap-1">
                      sets
                      <input
                        type="number" min={1} max={10}
                        value={it.sets ?? ""}
                        onChange={(e) =>
                          updateItem(idx, { sets: boundedOrNull(e.target.value, 1, 10) })
                        }
                        className={numInput}
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      reps
                      <input
                        type="number" min={1} max={50}
                        value={it.reps ?? ""}
                        onChange={(e) =>
                          updateItem(idx, { reps: boundedOrNull(e.target.value, 1, 50) })
                        }
                        className={numInput}
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      hold s
                      <input
                        type="number" min={1} max={300}
                        value={it.holdSecs ?? ""}
                        onChange={(e) =>
                          updateItem(idx, { holdSecs: boundedOrNull(e.target.value, 1, 300) })
                        }
                        className={numInput}
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      ×/week
                      <input
                        type="number" min={1} max={14}
                        value={it.frequencyPerWeek}
                        onChange={(e) =>
                          updateItem(idx, {
                            frequencyPerWeek: boundedOrNull(e.target.value, 1, 14) ?? 5,
                          })
                        }
                        className={numInput}
                      />
                    </label>
                  </div>
                  <input
                    value={it.rationale ?? ""}
                    onChange={(e) => updateItem(idx, { rationale: e.target.value })}
                    placeholder="Why (patient-visible after approval)"
                    className="mt-2 w-full rounded-md border border-edge bg-card px-2 py-1.5 text-xs outline-none focus:border-accent"
                  />
                </li>
              ))}
            </ul>

            <div className="relative">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Add exercise — search the library…"
                className="w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
              />
              {hits.length > 0 && (
                <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-edge bg-card shadow-lg">
                  {hits.map((h) => (
                    <li key={h.id}>
                      <button
                        onClick={() => {
                          setDraftItems((prev) => [
                            ...(prev ?? []),
                            {
                              exerciseId: h.id,
                              name: h.name,
                              image: null,
                              sets: 3,
                              reps: 10,
                              holdSecs: null,
                              frequencyPerWeek: 5,
                              location: "home",
                              rationale: "",
                            },
                          ]);
                          setDirty(true);
                          setSearch("");
                          setHits([]);
                        }}
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-raise"
                      >
                        {h.name}
                        {h.difficulty ? (
                          <span className="ml-2 text-xs text-muted">lvl {h.difficulty}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            </fieldset>

            <div className="flex flex-wrap gap-2 border-t border-edge pt-3">
              <button
                onClick={() => void approve()}
                disabled={busy !== null || draftItems.length === 0}
                className="rounded-lg bg-accent-deep px-5 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
              >
                {busy === "approve" ? "Approving…" : "Approve & assign"}
              </button>
              <button
                onClick={() => void saveDraft()}
                disabled={!dirty || busy !== null}
                className="rounded-lg border border-edge px-4 py-2 text-sm font-medium hover:bg-raise disabled:opacity-40"
              >
                {busy === "save" ? "Saving…" : dirty ? "Save draft" : "Saved"}
              </button>
              <button
                onClick={() => void discardDraft()}
                disabled={busy !== null}
                className="ml-auto rounded-lg px-3 py-2 text-sm text-muted hover:text-flag"
              >
                Discard draft
              </button>
            </div>
          </div>
        )}

        {/* Active plan (read-only) */}
        {!draftItems && activePlan && (
          <div className="mt-3">
            <p className="text-xs text-muted">
              Active since {new Date(activePlan.approvedAt!).toLocaleDateString()} ·{" "}
              {activePlan.source === "ai-draft" ? "AI-drafted, PT-approved" : "built manually"}
            </p>
            <ul className="mt-2 space-y-1.5">
              {activePlan.items.map((it) => (
                <li
                  key={it.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-raise/60 px-3 py-2 text-sm"
                >
                  <span className="font-medium">{it.name}</span>
                  <span className="text-xs text-muted">
                    {it.sets ? `${it.sets}×` : ""}
                    {it.reps ?? ""}
                    {it.holdSecs ? `${it.sets ? " · " : ""}${it.holdSecs}s hold` : ""} ·{" "}
                    {it.frequencyPerWeek}/wk · {it.location}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!draftItems && !activePlan && !data.latestIntake && (
          <p className="mt-2 text-sm text-muted">Complete an intake first, then draft a plan.</p>
        )}
      </section>
    </div>
  );
}
