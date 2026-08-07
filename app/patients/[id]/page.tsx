"use client";

// The PT's patient page (PRD build step 3, the wow demo): intake → "Draft with
// AI" → edit the draft → approve. Approved plans are read-only; a new draft
// replaces the active plan only at the moment of approval.

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import AdherencePanel from "@/components/AdherencePanel";
import { useAuth } from "@/components/AuthContext";
import ExerciseComposer from "@/components/ExerciseComposer";
import { GoalsPanel } from "@/components/Goals";
import IntakeForm, { type IntakePayload } from "@/components/IntakeForm";
import IntakeSummary from "@/components/IntakeSummary";
import NotesPanel from "@/components/NotesPanel";
import { PlanDoors, ReviewBanner, RowSteps, type Review } from "@/components/ReviewPanel";
import ReviewTimeline from "@/components/ReviewTimeline";
import VisitMode from "@/components/VisitMode";
import { dosageText, dosageTypeOf, type DosageType } from "@/lib/dosage";
import { REGION_OPTIONS, type IntakeRecord } from "@/lib/intake/fields";

type Intake = IntakeRecord & { patientSubmitted: boolean };

type Item = {
  id?: string;
  exerciseId: string;
  name: string;
  image: string | null;
  dosageType: DosageType;
  kind: "exercise" | "modality";
  sets: number | null;
  reps: number | null;
  holdSecs: number | null;
  durationMins: number | null;
  intensity: string | null;
  frequencyPerWeek: number;
  location: "office" | "home" | "both";
  rationale: string | null;
  careTiming: "before" | "after" | null;
};

type EquipmentSuggestion = { slug: string; name: string; reason: string };

type Plan = {
  id: string;
  status: "draft" | "active";
  source: string;
  model: string | null;
  createdAt: string;
  approvedAt: string | null;
  equipmentSuggestions: EquipmentSuggestion[] | null;
  aiNote: string | null;
  items: Item[];
};

type Overview = {
  patient: {
    id: string;
    displayName: string | null;
    email: string | null;
    birthYear: number | null;
  };
  equipment: string[];
  episode: { id: string; condition: string } | null;
  latestIntake: Intake | null;
  plans: Plan[];
  review: Review | null;
};

type SearchHit = {
  id: string;
  name: string;
  difficulty: number | null;
  dosageType: DosageType;
  kind: "exercise" | "modality";
};

export default function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: patientId } = use(params);
  const clinicId = useSearchParams().get("clinic") ?? "";
  const { enabled, loading, session } = useAuth();
  const authReady = !loading && (!enabled || !!session);

  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dashboardKey, setDashboardKey] = useState(0);
  // Bumped on every reload so the check-in history refetches after any
  // decision (swap, revamp approval, no-change) without its own plumbing.
  const [timelineKey, setTimelineKey] = useState(0);

  // Intake form open/closed — the fields themselves live in IntakeForm.
  const [showIntake, setShowIntake] = useState(false);

  // Draft editor state (mirrors the draft plan's items)
  const [draftItems, setDraftItems] = useState<Item[] | null>(null);
  // Which AI equipment suggestions survive the PT's pruning — save persists
  // the subset, approval publishes it to the patient's Today.
  const [keptSuggestions, setKeptSuggestions] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [composing, setComposing] = useState<string | null>(null);
  // Picker facets (Dan's ask: "more than just the search bar"). kind=modality
  // is the first manual path care has ever had into a plan — before this,
  // only the AI could prescribe ice.
  const [pickRegion, setPickRegion] = useState("");
  const [pickLevel, setPickLevel] = useState("");
  const [pickKind, setPickKind] = useState<"exercise" | "modality" | "any">("exercise");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Drop a freshly created (or searched) exercise straight into the draft,
   *  seeded with the dosage its type expects. Care defaults to daily — you
   *  don't ice three times a week. */
  function addToDraft(hit: {
    id: string;
    name: string;
    dosageType: DosageType;
    kind?: "exercise" | "modality";
  }) {
    const kind = hit.kind ?? "exercise";
    setDraftItems((prev) => [
      ...(prev ?? []),
      {
        exerciseId: hit.id,
        name: hit.name,
        image: null,
        dosageType: hit.dosageType,
        kind,
        sets: hit.dosageType === "time" ? null : 3,
        reps: hit.dosageType === "reps" ? 10 : null,
        holdSecs: hit.dosageType === "hold" ? 20 : null,
        durationMins: hit.dosageType === "time" ? (kind === "modality" ? 15 : 10) : null,
        intensity: null,
        frequencyPerWeek: kind === "modality" ? 7 : 5,
        location: "home",
        rationale: "",
        careTiming: null,
      },
    ]);
    setDirty(true);
    setSearch("");
    setHits([]);
  }

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
      setKeptSuggestions((draft?.equipmentSuggestions ?? []).map((s) => s.slug));
      setDirty(false);
      setTimelineKey((n) => n + 1);
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

  // Exercise search for the editor's add row. A set facet searches with an
  // empty q — "show me knee work under level 2" is a browse, not a lookup.
  // All setState happens inside the debounce callback (async), never in the
  // effect body itself.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = search.trim();
    const filtered = !!(pickRegion || pickLevel || pickKind !== "exercise");
    searchTimer.current = setTimeout(
      async () => {
        if (!q && !filtered) {
          setHits([]);
          return;
        }
        const params = new URLSearchParams({ limit: "12" });
        if (q) params.set("q", q);
        if (pickRegion) params.set("region", pickRegion);
        if (pickLevel) params.set("difficulty", pickLevel);
        if (pickKind !== "exercise") params.set("kind", pickKind);
        const res = await apiFetch(`/api/exercises?${params}`);
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
  }, [search, pickRegion, pickLevel, pickKind]);

  async function submitIntake(payload: IntakePayload) {
    // The post-intake reload rebuilds the draft editor from the server —
    // unsaved draft edits must land first (same contract as approve()).
    if (dirty && !(await saveDraft())) return;
    setBusy("intake");
    setError(null);
    try {
      const res = await apiFetch("/api/intakes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinicId, patientUserId: patientId, ...payload }),
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

  /** basis "progress" is the revamp: the model sees the current plan, what was
   *  logged against it, and the pain trend. Chosen by whether there IS a plan
   *  to revise rather than by a toggle — a draft that ignores six weeks of
   *  evidence is never the one a PT wanted. */
  async function draftWithAi(basis: "intake" | "progress", note = "") {
    if (!data?.episode) return;
    setBusy("draft");
    setError(null);
    try {
      const res = await apiFetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeId: data.episode.id, source: "ai-draft", basis, note }),
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

  const draftPlan = data?.plans.find((p) => p.status === "draft");
  const draftPlanId = draftPlan?.id;

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
            durationMins: i.durationMins,
            intensity: i.intensity,
            frequencyPerWeek: i.frequencyPerWeek,
            location: i.location,
            rationale: i.rationale,
            careTiming: i.careTiming,
          })),
          keepSuggestionSlugs: keptSuggestions,
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

      {/* Intake. A patient-submitted one renders with a review banner; the
          PT's "Review intake" pre-fills the form from it and saving mints the
          PT-authored row that supersedes it (append-only, as ever). */}
      <section className="rounded-xl border border-edge bg-card p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Intake</h2>
          {!showIntake && (
            <button
              onClick={() => setShowIntake(true)}
              className="rounded-full border border-edge px-3 py-1 text-sm text-muted hover:bg-raise"
            >
              {data.latestIntake
                ? data.latestIntake.patientSubmitted
                  ? "Review intake"
                  : "New intake"
                : "Start intake"}
            </button>
          )}
        </div>

        {!showIntake && data.latestIntake && (
          <IntakeSummary
            intake={data.latestIntake}
            birthYear={data.patient.birthYear}
            patientSubmitted={data.latestIntake.patientSubmitted}
          />
        )}
        {!showIntake && !data.latestIntake && (
          <p className="mt-2 text-sm text-muted">
            No intake yet — it powers the AI draft and the library filtering. {name} can
            pre-fill it from their own Today page before the first visit.
          </p>
        )}

        {showIntake && (
          <IntakeForm
            persona="pt"
            initial={data.latestIntake}
            initialBirthYear={data.patient.birthYear}
            busy={busy === "intake"}
            submitLabel="Save intake"
            onSubmit={(p) => void submitIntake(p)}
            onCancel={() => setShowIntake(false)}
          />
        )}
      </section>

      {/* Plan */}
      <section className="rounded-xl border border-edge bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Plan</h2>
          {/* Only the FIRST draft is offered here. Once a plan is active, the
              next one is a check-in decision and lives in that panel, where the
              PT can see what they're revising from. */}
          {!draftItems && !activePlan && data.latestIntake && (
            <button
              onClick={() => void draftWithAi("intake")}
              disabled={busy === "draft"}
              className="rounded-full bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
            >
              {busy === "draft" ? "Drafting…" : "✨ Draft with AI"}
            </button>
          )}
        </div>

        {/* Draft editor */}
        {draftItems && (
          <div className="mt-3 space-y-3">
            <p className="rounded-lg bg-raise/70 px-3 py-2 text-xs text-muted">
              {`Draft — nothing reaches ${name} until you approve. Edit dosage, swap or remove items, and rewrite any rationale (it's shown to the patient after approval).`}
            </p>
            {draftPlan?.aiNote && (
              <p className="rounded-lg border border-flag/40 bg-flag/5 px-3 py-2 text-xs">
                <span className="font-semibold">For your eyes only</span> — the draft flagged:{" "}
                {draftPlan.aiNote}
              </p>
            )}
            {/* fieldset disables every control inside while a request is in
                flight — the save snapshot can never diverge from the screen */}
            <fieldset disabled={busy !== null} className="space-y-3">
            <ul className="space-y-2">
              {draftItems.map((it, idx) => (
                <li key={`${it.exerciseId}-${idx}`} className="rounded-lg border border-edge p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold">
                      {it.name}
                      {it.kind === "modality" && (
                        <span className="ml-2 rounded-full bg-raise px-2 py-0.5 text-xs font-normal text-muted">
                          care
                        </span>
                      )}
                    </span>
                    <div className="flex items-center gap-2 text-xs">
                      {/* "Ice before or after?" — timing only exists for care. */}
                      {it.kind === "modality" && (
                        <select
                          value={it.careTiming ?? ""}
                          onChange={(e) =>
                            updateItem(idx, {
                              careTiming: (e.target.value || null) as Item["careTiming"],
                            })
                          }
                          className="rounded-md border border-edge bg-card px-1.5 py-1"
                        >
                          <option value="">anytime</option>
                          <option value="before">before exercises</option>
                          <option value="after">after exercises</option>
                        </select>
                      )}
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
                  {/* Only the fields this item's dosage type actually means.
                      A bike showing sets/reps invites a nonsense prescription,
                      and the patient's logger renders from the same type. */}
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
                    {dosageTypeOf(it) === "time" ? (
                      <>
                        <label className="flex items-center gap-1">
                          minutes
                          <input
                            type="number" min={1} max={240}
                            value={it.durationMins ?? ""}
                            onChange={(e) =>
                              updateItem(idx, {
                                durationMins: boundedOrNull(e.target.value, 1, 240),
                              })
                            }
                            className={numInput}
                          />
                        </label>
                        <label className="flex items-center gap-1">
                          intensity
                          <input
                            value={it.intensity ?? ""}
                            onChange={(e) => updateItem(idx, { intensity: e.target.value })}
                            placeholder="level 2"
                            className="w-24 rounded-md border border-edge bg-card px-1.5 py-1 text-center text-sm outline-none focus:border-accent"
                          />
                        </label>
                      </>
                    ) : (
                      <>
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
                        {dosageTypeOf(it) === "hold" ? (
                          <label className="flex items-center gap-1">
                            hold s
                            <input
                              type="number" min={1} max={300}
                              value={it.holdSecs ?? ""}
                              onChange={(e) =>
                                updateItem(idx, {
                                  holdSecs: boundedOrNull(e.target.value, 1, 300),
                                })
                              }
                              className={numInput}
                            />
                          </label>
                        ) : (
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
                        )}
                      </>
                    )}
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
                  {/* PTs type here for real — a one-line box made every note
                      a telegram (Dan's ask #6). */}
                  <textarea
                    value={it.rationale ?? ""}
                    onChange={(e) => updateItem(idx, { rationale: e.target.value })}
                    rows={2}
                    placeholder="Why (patient-visible after approval)"
                    className="mt-2 w-full rounded-md border border-edge bg-card px-2 py-1.5 text-xs outline-none focus:border-accent"
                  />
                </li>
              ))}
            </ul>

            {/* Equipment worth acquiring — the model's picks, the PT's veto.
                Survivors reach the patient's Today after approval. */}
            {(draftPlan?.equipmentSuggestions?.length ?? 0) > 0 && (
              <div className="rounded-lg border border-edge p-3">
                <p className="text-xs font-medium text-muted">
                  Worth getting — shown to {name} after approval. Remove any you don&apos;t
                  want suggested.
                </p>
                <ul className="mt-2 space-y-1.5">
                  {draftPlan!.equipmentSuggestions!
                    .filter((s) => keptSuggestions.includes(s.slug))
                    .map((s) => (
                      <li
                        key={s.slug}
                        className="flex items-start justify-between gap-2 rounded-lg bg-raise/60 px-3 py-1.5 text-sm"
                      >
                        <span>
                          <span className="font-medium">{s.name}</span>
                          <span className="text-muted"> — {s.reason}</span>
                        </span>
                        <button
                          onClick={() => {
                            setKeptSuggestions((prev) => prev.filter((x) => x !== s.slug));
                            setDirty(true);
                          }}
                          className="text-muted hover:text-flag"
                          title="Don't suggest this"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  {draftPlan!.equipmentSuggestions!.every(
                    (s) => !keptSuggestions.includes(s.slug),
                  ) && <li className="text-xs text-muted">None kept — nothing will be suggested.</li>}
                </ul>
              </div>
            )}

            {composing !== null ? (
              <ExerciseComposer
                initialName={composing}
                clinicId={clinicId}
                onCreated={(created) => {
                  setComposing(null);
                  addToDraft(created);
                }}
                onCancel={() => setComposing(null)}
              />
            ) : (
              <div className="relative">
                <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
                  <div className="flex overflow-hidden rounded-full border border-edge">
                    {(
                      [
                        ["exercise", "Exercises"],
                        ["modality", "Care"],
                        ["any", "All"],
                      ] as const
                    ).map(([v, label]) => (
                      <button
                        key={v}
                        onClick={() => setPickKind(v)}
                        className={`px-2.5 py-1 ${
                          pickKind === v ? "bg-accent-deep font-medium text-white" : "text-muted hover:bg-raise"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <select
                    value={pickRegion}
                    onChange={(e) => setPickRegion(e.target.value)}
                    className="rounded-md border border-edge bg-card px-1.5 py-1"
                  >
                    <option value="">any region</option>
                    {REGION_OPTIONS.map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={pickLevel}
                    onChange={(e) => setPickLevel(e.target.value)}
                    className="rounded-md border border-edge bg-card px-1.5 py-1"
                  >
                    <option value="">any level</option>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        up to lvl {n}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={
                    pickKind === "modality"
                      ? "Add care — ice, heat, TENS…"
                      : "Add exercise — search name or tag, or just set a filter…"
                  }
                  className="w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
                />
                {(search.trim() || pickRegion || pickLevel || pickKind !== "exercise") && (
                  <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-edge bg-card shadow-lg">
                    {hits.map((h) => (
                      <li key={h.id}>
                        <button
                          onClick={() => addToDraft(h)}
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-raise"
                        >
                          {h.name}
                          {h.kind === "modality" && (
                            <span className="ml-2 rounded-full bg-raise px-2 py-0.5 text-xs text-muted">
                              care
                            </span>
                          )}
                          {h.difficulty && h.kind !== "modality" ? (
                            <span className="ml-2 text-xs text-muted">lvl {h.difficulty}</span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                    {hits.length === 0 && (
                      <li className="px-3 py-2 text-sm text-muted">Nothing matches.</li>
                    )}
                    {/* Always offered when there's a name to give it, not only
                        on zero results: the search may have found something
                        similar-but-wrong, and that's exactly when a PT wants
                        their own version. */}
                    {search.trim() && (
                      <li className="border-t border-edge">
                        <button
                          onClick={() => setComposing(search.trim())}
                          className="block w-full px-3 py-2 text-left text-sm text-accent-deep hover:bg-raise"
                        >
                          ＋ Create &ldquo;{search.trim()}&rdquo; for this clinic
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}
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

        {/* Active plan — the check-in lives IN the table now: the signal
            banner up top, each row carrying its own charted steps, and the
            whole-plan doors at the foot. One place to look, one decision. */}
        {!draftItems && activePlan && data.episode && (
          <div className="mt-1">
            <ReviewBanner review={data.review} patientName={name} />
            {(data.review?.goals?.length ?? 0) > 0 && (
              <GoalsPanel
                goals={data.review!.goals!}
                patientId={patientId}
                clinicId={clinicId}
                patientName={name}
                onChanged={reload}
              />
            )}
            <p className="mt-3 text-xs text-muted">
              Active since {new Date(activePlan.approvedAt!).toLocaleDateString()} ·{" "}
              {activePlan.source === "ai-draft"
                ? "AI-drafted, PT-approved"
                : activePlan.source === "progression"
                  ? "one exercise stepped along the chain at a check-in"
                  : "built manually"}
            </p>
            <ul className="mt-2 space-y-1.5">
              {activePlan.items.map((it) => {
                const steps = (data.review?.progressions ?? []).filter(
                  (p) => p.planItemId === it.id,
                );
                return (
                  <li key={it.id} className="rounded-lg bg-raise/60 px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        {it.name}
                        {it.kind === "modality" && (
                          <span className="ml-2 rounded-full bg-raise px-2 py-0.5 text-xs text-muted">
                            care
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-muted">
                        {dosageText(it)} · {it.frequencyPerWeek}/wk · {it.location}
                        {it.careTiming ? ` · ${it.careTiming} exercises` : ""}
                      </span>
                    </div>
                    {typeof it.id === "string" && steps.length > 0 && (
                      <RowSteps
                        item={it as typeof it & { id: string }}
                        progressions={steps}
                        activePlanId={activePlan.id}
                        patientName={name}
                        onChanged={reload}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
            {(activePlan.equipmentSuggestions?.length ?? 0) > 0 && (
              <p className="mt-2 text-xs text-muted">
                Suggested to get:{" "}
                {activePlan.equipmentSuggestions!
                  .map((s) => s.name)
                  .join(", ")}{" "}
                — {name} sees this on their Today page.
              </p>
            )}
            <PlanDoors
              episodeId={data.episode.id}
              patientName={name}
              daysOnPlan={data.review?.daysOnPlan ?? null}
              due={data.review?.due ?? false}
              onRevamp={(note) => draftWithAi("progress", note)}
              revamping={busy === "draft"}
              onChanged={reload}
            />
          </div>
        )}

        {!draftItems && !activePlan && !data.latestIntake && (
          <p className="mt-2 text-sm text-muted">Complete an intake first, then draft a plan.</p>
        )}
      </section>

      {/* Every decision ever made on this episode, with its frozen numbers. */}
      {data.episode && (
        <ReviewTimeline patientId={patientId} clinicId={clinicId} refreshKey={timelineKey} />
      )}

      {/* In-office quick mode (step 6): what happened in the room. */}
      {data.episode && (
        <VisitMode
          episodeId={data.episode.id}
          // Only server-persisted rows carry an id, and a visit item can only
          // link back to one that exists — the draft editor's in-flight items
          // have none until they're saved.
          planItems={(activePlan?.items ?? []).filter(
            (i): i is Item & { id: string } => typeof i.id === "string",
          )}
          onVisitEnded={() => setDashboardKey((n) => n + 1)}
        />
      )}

      {/* Adherence dashboard. Keyed on the active plan so approving one
          remounts the panel — its window is measured from the approval date —
          and on a counter a finished visit bumps, so the visit count it shows
          is never a session behind. */}
      {data.episode && (
        <AdherencePanel
          key={`${activePlan?.id ?? "no-plan"}:${dashboardKey}`}
          patientId={patientId}
          clinicId={clinicId}
          patientName={name}
        />
      )}

      {/* Notes, both sides (step 7). */}
      {data.episode && <NotesPanel episodeId={data.episode.id} patientName={name} />}
    </div>
  );
}
