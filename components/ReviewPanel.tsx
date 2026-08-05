"use client";

// The check-in surface (Dan's ask #2).
//
// THE RULE, his call on 2026-08-02: the app surfaces the signal, the PT decides
// what it means. So this panel states measurements and offers doors. It never
// says "ready to progress", never ranks the options, and never pre-selects one.
// Read the copy below with that in mind before changing any of it.
//
// Three doors, deliberately different sizes:
//   ↑ / ↓  one exercise moves along the clinic's charted chain. No AI, no
//          re-intake, no draft-then-approve — the press IS the approval.
//   ✨     the whole plan gets redrafted, this time with six weeks of evidence
//          in front of the model instead of the intake form alone.
//   ✓      nothing changes. Still a decision, and it resets the clock so the
//          same chip doesn't greet the PT again tomorrow.

import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
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
  location: "office" | "home" | "both";
};

const REQUEST_TEXT: Record<string, string> = {
  too_easy: "this feels too easy now",
  too_hard: "this is too much right now",
  something_changed: "something has changed",
};

/** What the patient will actually be looking at tomorrow. A swap that silently
 *  resets a 20-second hold to a rep count, or moves an exercise out of the home
 *  program because the successor needs a band, has to be visible BEFORE the
 *  press — it reaches the patient the moment it lands. */
function SwapPreview({ from, to }: { from: PlanItem | undefined; to: Progression }) {
  const sameShape = from?.dosageType === to.dosageType;
  const seeded: PlanItem = sameShape
    ? { ...(from as PlanItem) }
    : {
        name: to.toName,
        dosageType: to.dosageType,
        sets: to.dosageType === "time" ? null : 3,
        reps: to.dosageType === "reps" ? 10 : null,
        holdSecs: to.dosageType === "hold" ? 20 : null,
        durationMins: to.dosageType === "time" ? 10 : null,
        intensity: null,
        location: from?.location ?? "home",
      };
  const demoted = !!from && from.location !== "office" && !to.homeEligible;

  return (
    <p className="text-xs text-muted">
      Will be prescribed as <span className="font-medium text-ink">{dosageText(seeded)}</span>
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

export default function ReviewPanel({
  episodeId,
  activePlanId,
  patientName,
  review,
  items,
  onChanged,
  onRevamp,
  revamping,
}: {
  episodeId: string;
  activePlanId: string | null;
  patientName: string;
  review: Review | null;
  items: PlanItem[];
  onChanged: () => void | Promise<void>;
  onRevamp: (note: string) => void | Promise<void>;
  revamping: boolean;
}) {
  const [picked, setPicked] = useState<Progression | null>(null);
  const [why, setWhy] = useState("");
  const [steer, setSteer] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const firstName = patientName.split(" ")[0];
  const chain = review?.progressions ?? [];

  async function swap() {
    if (!picked || !activePlanId) return;
    setBusy("swap");
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
      setBusy(null);
    }
  }

  async function noChange() {
    setBusy("none");
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
      setBusy(null);
    }
  }

  if (!activePlanId) return null;

  return (
    <section
      className={`rounded-xl border bg-card p-5 ${
        review?.due ? "border-accent" : "border-edge"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Check-in</h2>
        {review?.due && (
          <span className="rounded-full bg-accent-deep px-3 py-0.5 text-xs font-medium text-white">
            due for review
          </span>
        )}
      </div>

      {review?.due ? (
        <div className="mt-2">
          <p className="text-sm font-medium">{review.line}</p>
          {review.request && (
            <p className="mt-1 rounded-lg bg-[var(--color-clinic)]/10 px-3 py-2 text-sm">
              <span className="font-medium">{firstName} asked for a check-in:</span>{" "}
              {REQUEST_TEXT[review.request.kind] ?? "something has changed"}
              {review.request.note && <span className="text-muted"> — “{review.request.note}”</span>}
            </p>
          )}
          <p className="mt-1 text-xs text-muted">
            What that means is your call — this is the data, not a recommendation.
          </p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted">
          Nothing calling for a review
          {review?.daysOnPlan
            ? ` (${review.daysOnPlan} day${review.daysOnPlan === 1 ? "" : "s"} on this plan)`
            : ""}
          . Change anything below whenever you want to.
        </p>
      )}

      {error && <p className="mt-2 text-sm text-flag">{error}</p>}

      {/* One exercise along the chain */}
      {chain.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Charted steps
          </h3>
          <ul className="mt-2 space-y-1.5">
            {chain.map((p) => {
              const key = `${p.planItemId}:${p.toExerciseId}`;
              const isPicked =
                picked?.planItemId === p.planItemId && picked?.toExerciseId === p.toExerciseId;
              const from = items.find((i) => i.id === p.planItemId);
              return (
                <li key={key} className="rounded-lg border border-edge px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>
                      <span className="text-muted">{p.fromName}</span>{" "}
                      <span className="text-muted">{p.direction === "up" ? "→" : "←"}</span>{" "}
                      <span className="font-medium">{p.toName}</span>
                      {p.difficulty !== null && (
                        <span className="ml-2 text-xs text-muted">lvl {p.difficulty}</span>
                      )}
                    </span>
                    <button
                      onClick={() => {
                        setPicked(isPicked ? null : p);
                        setWhy("");
                      }}
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        isPicked
                          ? "bg-raise text-muted"
                          : p.direction === "up"
                            ? "bg-accent-deep text-white hover:brightness-110"
                            : "border border-edge text-muted hover:bg-raise"
                      }`}
                    >
                      {isPicked ? "Cancel" : p.direction === "up" ? "↑ Progress" : "↓ Ease off"}
                    </button>
                  </div>
                  {/* Only ever set for "up": the clinic's edge note describes
                      moving forward, and reading it beside an ease-off button
                      would be nonsense. */}
                  {p.note && !isPicked && <p className="mt-1 text-xs text-muted">{p.note}</p>}

                  {isPicked && (
                    <div className="mt-2 space-y-2 border-t border-edge pt-2">
                      <SwapPreview from={from} to={p} />
                      <input
                        value={why}
                        onChange={(e) => setWhy(e.target.value)}
                        placeholder={`Why (optional) — ${firstName} reads this`}
                        className="w-full rounded-md border border-edge bg-card px-2 py-1.5 text-xs outline-none focus:border-accent"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => void swap()}
                          disabled={busy !== null}
                          className="rounded-lg bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
                        >
                          {busy === "swap" ? "Updating…" : `Swap it in for ${firstName}`}
                        </button>
                        <span className="text-xs text-muted">
                          Takes effect immediately — the rest of the plan is untouched.
                        </span>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* The whole plan */}
      <div className="mt-4 space-y-2 border-t border-edge pt-4">
        <input
          value={steer}
          onChange={(e) => setSteer(e.target.value)}
          placeholder="Anything the AI should know for the next phase (optional)"
          className="w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void onRevamp(steer)}
            disabled={revamping || busy !== null}
            className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            {revamping ? "Drafting…" : "✨ Draft the next phase"}
          </button>
          <button
            onClick={() => void noChange()}
            disabled={busy !== null || revamping}
            className="rounded-lg border border-edge px-4 py-2 text-sm font-medium hover:bg-raise disabled:opacity-40"
          >
            {busy === "none" ? "Saving…" : "No change today"}
          </button>
        </div>
        <p className="text-xs text-muted">
          The draft reads {firstName}&apos;s logs, pain scores and notes since the current plan was
          approved — you still approve it before anything changes.
        </p>
      </div>
    </section>
  );
}
