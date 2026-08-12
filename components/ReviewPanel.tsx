"use client";

// The check-in, baked into the plan table (Dan's ask: "cant this just be
// baked into the plan table?" — it can, and it's better there. A PT deciding
// whether to progress Quad Set shouldn't look at the plan in one box and the
// buttons for it in another).
//
// THE RULE, his call on 2026-08-02, unchanged by the move: the app surfaces
// the signal, the PT decides what it means. Measurements and doors, never
// "ready to progress", never a ranked option, never a pre-selected one.
//
// Three doors, deliberately different sizes:
//   ↑ / ↓  one exercise moves along the clinic's charted chain — now pills ON
//          its own plan row. No AI, no re-intake — the press IS the approval.
//   ✨     the whole plan gets redrafted with the evidence in front of the
//          model — the plan section's footer.
//   ✓      nothing changes. Still a decision; resets the clock.

import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { GoalRow } from "@/components/Goals";
import { dosageText, type DosageType } from "@/lib/dosage";

export type Progression = {
  planItemId: string;
  fromExerciseId: string;
  fromName: string;
  toExerciseId: string;
  toName: string;
  direction: "up" | "down";
  note: string | null;
  dosageType: DosageType;
  difficulty: number | null;
  homeEligible: boolean;
};

export type Review = {
  due: boolean;
  line: string;
  daysOnPlan: number | null;
  request: { kind: string; note: string | null; on: string } | null;
  progressions: Progression[];
  /** Intake goals beside their latest re-rate — the progress-report rows. */
  goals: GoalRow[] | null;
};

type PlanItem = {
  id?: string;
  name: string;
  dosageType: DosageType;
  sets: number | null;
  reps: number | null;
  holdSecs: number | null;
  durationMins: number | null;
  intensity: string | null;
  frequencyPerWeek: number;
  location: "office" | "home" | "both";
};

const REQUEST_TEXT: Record<string, string> = {
  too_easy: "this feels too easy now",
  too_hard: "this is too much right now",
  something_changed: "something has changed",
};

/** The signal, shown at the top of the Plan section when it has something to
 *  say. States measurements; the verdict stays the PT's. */
export function ReviewBanner({
  review,
  patientName,
}: {
  review: Review | null;
  patientName: string;
}) {
  if (!review?.due) return null;
  const firstName = patientName.split(" ")[0];
  return (
    <div className="mt-3 rounded-lg border border-accent bg-accent/5 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-accent-deep px-3 py-0.5 text-xs font-medium text-white">
          due for review
        </span>
        <span className="text-sm font-medium">{review.line}</span>
      </div>
      {review.request && (
        <p className="mt-1.5 rounded-lg bg-[var(--color-clinic)]/10 px-3 py-2 text-sm">
          <span className="font-medium">{firstName} asked for a check-in:</span>{" "}
          {REQUEST_TEXT[review.request.kind] ?? "something has changed"}
          {review.request.note && <span className="text-muted"> — “{review.request.note}”</span>}
        </p>
      )}
      <p className="mt-1 text-xs text-muted">
        What that means is your call — this is the data, not a recommendation. Step one
        exercise below, redraft the phase, or record no change.
      </p>
    </div>
  );
}

/** What the patient will actually be looking at tomorrow. A swap that silently
 *  resets a 20-second hold to a rep count, or moves an exercise out of the home
 *  program because the successor needs a band, has to be visible BEFORE the
 *  press — it reaches the patient the moment it lands. */
function SwapPreview({ from, to }: { from: PlanItem; to: Progression }) {
  const sameShape = from.dosageType === to.dosageType;
  const seeded: PlanItem = sameShape
    ? { ...from }
    : {
        name: to.toName,
        dosageType: to.dosageType,
        sets: to.dosageType === "time" ? null : 3,
        reps: to.dosageType === "reps" ? 10 : null,
        holdSecs: to.dosageType === "hold" ? 20 : null,
        durationMins: to.dosageType === "time" ? 10 : null,
        intensity: null,
        frequencyPerWeek: from.frequencyPerWeek,
        location: from.location,
      };
  const demoted = from.location !== "office" && !to.homeEligible;

  return (
    <p className="text-xs text-muted">
      Will be prescribed as{" "}
      <span className="font-medium text-ink">
        {dosageText(seeded)} · {from.frequencyPerWeek}/wk
      </span>
      {sameShape ? " — same dosage as now" : " — a starting dosage, edit after"}
      {demoted && (
        <span className="text-flag">
          {" "}
          · needs equipment they haven&apos;t got at home, so it moves to in-office
        </span>
      )}
    </p>
  );
}

/** The charted steps off ONE plan row — pills beside the exercise they'd
 *  replace, expanding in place to preview + confirm. */
export function RowSteps({
  item,
  progressions,
  activePlanId,
  patientName,
  onChanged,
}: {
  item: PlanItem & { id: string };
  progressions: Progression[];
  activePlanId: string;
  patientName: string;
  onChanged: () => void | Promise<void>;
}) {
  const [picked, setPicked] = useState<Progression | null>(null);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstName = patientName.split(" ")[0];
  if (progressions.length === 0) return null;

  async function swap() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/plans/${activePlanId}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planItemId: picked.planItemId,
          toExerciseId: picked.toExerciseId,
          note: why,
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `couldn't make that change (${res.status})`);
        return;
      }
      setPicked(null);
      setWhy("");
      await onChanged();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1.5 w-full">
      <div className="flex flex-wrap items-center gap-1.5">
        {progressions.map((p) => {
          const isPicked = picked?.toExerciseId === p.toExerciseId;
          return (
            <button
              key={p.toExerciseId}
              onClick={() => {
                setPicked(isPicked ? null : p);
                setWhy("");
                setError(null);
              }}
              title={p.note ?? undefined}
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                isPicked
                  ? "bg-raise text-muted"
                  : p.direction === "up"
                    ? "bg-accent-deep text-white hover:brightness-110"
                    : "border border-edge text-muted hover:bg-raise"
              }`}
            >
              {isPicked ? "cancel" : `${p.direction === "up" ? "↑" : "↓"} ${p.toName}`}
            </button>
          );
        })}
      </div>

      {picked && (
        <div className="mt-2 space-y-2 rounded-lg border border-edge bg-card p-2.5">
          <p className="text-xs">
            <span className="text-muted">{picked.direction === "up" ? "Progress" : "Ease off"}:</span>{" "}
            <span className="font-medium">
              {picked.fromName} → {picked.toName}
            </span>
            {picked.difficulty !== null && (
              <span className="ml-2 text-muted">lvl {picked.difficulty}</span>
            )}
          </p>
          {/* The clinic's edge note describes moving forward — shown for the
              up direction only, same rule as before the merge. */}
          {picked.note && picked.direction === "up" && (
            <p className="text-xs text-muted">{picked.note}</p>
          )}
          <SwapPreview from={item} to={picked} />
          <textarea
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            rows={2}
            placeholder={`Why (optional) — ${firstName} reads this`}
            className="w-full rounded-md border border-edge bg-card px-2 py-1.5 text-xs outline-none focus:border-accent"
          />
          {error && <p className="text-xs text-flag">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void swap()}
              disabled={busy}
              className="rounded-lg bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
            >
              {busy ? "Updating…" : `Swap it in for ${firstName}`}
            </button>
            <span className="text-xs text-muted">
              Takes effect immediately — the rest of the plan is untouched.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export type AdjustableItem = PlanItem & {
  id: string;
  kind: "exercise" | "modality";
  rationale: string | null;
  careTiming: "before" | "after" | null;
};

/** Parse an input's value, empty allowed while typing — snapping a default
 *  back in turned a backspaced "7" into "57" on the phone. */
function numOrNull(v: string, lo: number, hi: number): number | null {
  if (v === "") return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, lo), hi);
}

const adjInput =
  "w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center outline-none focus:border-accent";

/** Edit ONE active-plan item in place (Dan's ask: "when I click into an
 *  exercise I should be able to edit it"). Saving mints an 'adjustment'
 *  revision — the approved record stays immutable, and the press is the
 *  approval, same contract as the ↑/↓ pills. */
export function AdjustItem({
  item,
  activePlanId,
  patientName,
  onChanged,
  onClose,
}: {
  item: AdjustableItem;
  activePlanId: string;
  patientName: string;
  onChanged: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [sets, setSets] = useState<number | null>(item.sets);
  const [reps, setReps] = useState<number | null>(item.reps);
  const [holdSecs, setHoldSecs] = useState<number | null>(item.holdSecs);
  const [durationMins, setDurationMins] = useState<number | null>(item.durationMins);
  const [intensity, setIntensity] = useState(item.intensity ?? "");
  const [freq, setFreq] = useState<number | null>(item.frequencyPerWeek);
  const [location, setLocation] = useState(item.location);
  const [careTiming, setCareTiming] = useState<"" | "before" | "after">(item.careTiming ?? "");
  const [rationale, setRationale] = useState(item.rationale ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstName = patientName.split(" ")[0];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/plans/${activePlanId}/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planItemId: item.id,
          sets,
          reps,
          holdSecs,
          durationMins,
          intensity: intensity || null,
          frequencyPerWeek: freq,
          location,
          rationale,
          careTiming: careTiming || null,
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `couldn't save that (${res.status})`);
        return;
      }
      onClose();
      await onChanged();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-edge bg-card p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        {item.dosageType === "time" ? (
          <>
            <label className="flex items-center gap-1 text-muted">
              <input
                type="number" min={1} max={240} value={durationMins ?? ""}
                onChange={(e) => setDurationMins(numOrNull(e.target.value, 1, 240))}
                className={adjInput}
              />
              min
            </label>
            <input
              value={intensity}
              onChange={(e) => setIntensity(e.target.value)}
              placeholder="intensity (level 2…)"
              className="w-36 rounded-md border border-edge bg-card px-2 py-1 outline-none focus:border-accent"
            />
          </>
        ) : (
          <>
            <label className="flex items-center gap-1 text-muted">
              <input
                type="number" min={1} max={10} value={sets ?? ""}
                onChange={(e) => setSets(numOrNull(e.target.value, 1, 10))}
                className={adjInput}
              />
              sets
            </label>
            {item.dosageType === "hold" ? (
              <label className="flex items-center gap-1 text-muted">
                hold
                <input
                  type="number" min={1} max={300} value={holdSecs ?? ""}
                  onChange={(e) => setHoldSecs(numOrNull(e.target.value, 1, 300))}
                  className={adjInput}
                />
                s
              </label>
            ) : (
              <label className="flex items-center gap-1 text-muted">
                ×
                <input
                  type="number" min={1} max={50} value={reps ?? ""}
                  onChange={(e) => setReps(numOrNull(e.target.value, 1, 50))}
                  className={adjInput}
                />
                reps
              </label>
            )}
          </>
        )}
        <label className="flex items-center gap-1 text-muted">
          <input
            type="number" min={1} max={14} value={freq ?? ""}
            onChange={(e) => setFreq(numOrNull(e.target.value, 1, 14))}
            className={adjInput}
          />
          /wk
        </label>
        <select
          value={location}
          onChange={(e) => setLocation(e.target.value as AdjustableItem["location"])}
          className="rounded-md border border-edge bg-card px-1.5 py-1"
        >
          <option value="home">home</option>
          <option value="office">office</option>
          <option value="both">both</option>
        </select>
        {item.kind === "modality" && (
          <select
            value={careTiming}
            onChange={(e) => setCareTiming(e.target.value as "" | "before" | "after")}
            className="rounded-md border border-edge bg-card px-1.5 py-1"
          >
            <option value="">anytime</option>
            <option value="before">before exercises</option>
            <option value="after">after exercises</option>
          </select>
        )}
      </div>
      <textarea
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        rows={2}
        placeholder={`Why (optional) — ${firstName} reads this`}
        className="w-full rounded-md border border-edge bg-card px-2 py-1.5 outline-none focus:border-accent"
      />
      {error && <p className="text-flag">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save change"}
        </button>
        <button onClick={onClose} className="text-muted underline hover:text-ink">
          cancel
        </button>
        <span className="text-muted">Takes effect immediately.</span>
      </div>
    </div>
  );
}

/** The whole-plan doors, at the foot of the plan: redraft with evidence, or
 *  record that nothing changes (which resets the review clock). */
const LEAN_OPTIONS = [
  ["harder", "Push harder"],
  ["same", "Hold about here"],
  ["easier", "Ease off"],
] as const;

const FOCUS_OPTIONS = [
  "more strength",
  "more mobility & stretching",
  "balance work",
  "endurance / cardio",
] as const;

const SIZE_OPTIONS = [
  ["fewer", "Fewer exercises"],
  ["same", "About this many"],
  ["more", "More exercises"],
] as const;

export function PlanDoors({
  episodeId,
  patientName,
  daysOnPlan,
  due,
  onRevamp,
  revamping,
  onChanged,
}: {
  episodeId: string;
  patientName: string;
  daysOnPlan: number | null;
  due: boolean;
  onRevamp: (note: string) => void | Promise<void>;
  revamping: boolean;
  onChanged: () => void | Promise<void>;
}) {
  // The redraft questionnaire (Dan: "It should ask me for information. Make
  // it dumb easy"). Three chip questions + a free line, composed into the
  // steer the AI reads. Every answer optional — chips beat a blank textarea
  // because they name the decisions a PT is actually making.
  const [asking, setAsking] = useState(false);
  const [lean, setLean] = useState<"harder" | "same" | "easier" | null>(null);
  const [focus, setFocus] = useState<string[]>([]);
  const [size, setSize] = useState<"fewer" | "same" | "more" | null>(null);
  const [steer, setSteer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstName = patientName.split(" ")[0];

  const chip = (on: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${
      on ? "border-accent-deep bg-accent-deep text-white" : "border-edge text-muted hover:bg-raise"
    }`;

  function composedSteer(): string {
    const parts: string[] = [];
    if (lean === "harder") parts.push("The PT wants the next phase harder overall.");
    if (lean === "same") parts.push("The PT wants the overall difficulty held about level.");
    if (lean === "easier") parts.push("The PT wants the next phase easier overall.");
    if (focus.length) parts.push(`Add or emphasize: ${focus.join(", ")}.`);
    if (size === "fewer") parts.push("Fewer exercises than the current plan.");
    if (size === "more") parts.push("More exercises than the current plan.");
    if (size === "same") parts.push("Keep the plan about the same size.");
    if (steer.trim()) parts.push(steer.trim());
    return parts.join(" ");
  }

  async function noChange() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeId }),
      });
      if (!res.ok) {
        setError(`couldn't record that (${res.status})`);
        return;
      }
      await onChanged();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-2 border-t border-edge pt-4">
      {!due && (
        <p className="text-xs text-muted">
          Nothing calling for a review
          {daysOnPlan ? ` (${daysOnPlan} day${daysOnPlan === 1 ? "" : "s"} on this plan)` : ""}.
          Change anything whenever you want to.
        </p>
      )}
      {!asking ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setAsking(true)}
            disabled={revamping || busy}
            className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            {revamping ? "Drafting…" : "✨ Draft the next phase"}
          </button>
          <button
            onClick={() => void noChange()}
            disabled={busy || revamping}
            className="rounded-lg border border-edge px-4 py-2 text-sm font-medium hover:bg-raise disabled:opacity-40"
          >
            {busy ? "Saving…" : "No change today"}
          </button>
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border border-edge bg-card p-3">
          <div>
            <p className="text-xs font-semibold text-muted">
              Which way should the next phase lean?
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {LEAN_OPTIONS.map(([v, label]) => (
                <button key={v} onClick={() => setLean(lean === v ? null : v)} className={chip(lean === v)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-muted">Anything to add or emphasize?</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {FOCUS_OPTIONS.map((f) => (
                <button
                  key={f}
                  onClick={() =>
                    setFocus((prev) =>
                      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f],
                    )
                  }
                  className={chip(focus.includes(f))}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-muted">How big should it be?</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {SIZE_OPTIONS.map(([v, label]) => (
                <button key={v} onClick={() => setSize(size === v ? null : v)} className={chip(size === v)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <textarea
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
            rows={2}
            placeholder="Anything else the AI should know (optional)"
            className="w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void onRevamp(composedSteer())}
              disabled={revamping}
              className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
            >
              {revamping ? "Drafting…" : "Draft it"}
            </button>
            <button
              onClick={() => {
                // Full reset — abandoned chips must not silently ride along
                // in a redraft the PT starts fresh next week.
                setAsking(false);
                setLean(null);
                setFocus([]);
                setSize(null);
                setSteer("");
              }}
              disabled={revamping}
              className="text-xs text-muted underline hover:text-ink disabled:opacity-40"
            >
              cancel
            </button>
            <span className="text-xs text-muted">Skip any question — it all helps, none is required.</span>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-flag">{error}</p>}
      <p className="text-xs text-muted">
        The draft reads {firstName}&apos;s logs, pain scores and notes since the current plan
        was approved — you still approve it before anything changes.
      </p>
    </div>
  );
}
