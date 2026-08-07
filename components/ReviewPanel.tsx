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

/** The whole-plan doors, at the foot of the plan: redraft with evidence, or
 *  record that nothing changes (which resets the review clock). */
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
  const [steer, setSteer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstName = patientName.split(" ")[0];

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
      <textarea
        value={steer}
        onChange={(e) => setSteer(e.target.value)}
        rows={2}
        placeholder="Anything the AI should know for the next phase (optional)"
        className="w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
      />
      {error && <p className="text-sm text-flag">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void onRevamp(steer)}
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
      <p className="text-xs text-muted">
        The draft reads {firstName}&apos;s logs, pain scores and notes since the current plan
        was approved — you still approve it before anything changes.
      </p>
    </div>
  );
}
