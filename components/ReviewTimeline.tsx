"use client";

// The episode's check-in history — plan_reviews rows have been accumulating
// since 0010 with nothing reading them back. Each entry is a decision a PT
// made, with the numbers as they stood AT THAT MOMENT (frozen context; logs
// stay editable, so recomputing would quietly rewrite history).
//
// This is the progress-report record: date, what the numbers said, what each
// goal stood at, which door the PT walked through, and what they wrote.

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";

type GoalSnap = {
  activity: string;
  baseline: number;
  current: number | null;
};

type Context = {
  daysOnPlan: number | null;
  windowDays: number;
  adherencePercent: number | null;
  painStart: number | null;
  painEnd: number | null;
  painDirection: string | null;
  triggers: string[];
  goals: GoalSnap[] | null;
} | null;

type ReviewRow = {
  id: string;
  outcome: "progressed" | "regressed" | "revamped" | "no_change";
  note: string | null;
  context: Context;
  on: string;
  reviewedByName: string | null;
};

const OUTCOME: Record<ReviewRow["outcome"], [string, string]> = {
  progressed: ["↑", "progressed one exercise"],
  regressed: ["↓", "eased one exercise off"],
  revamped: ["✨", "drafted a new phase"],
  no_change: ["✓", "no change"],
};

function day(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function contextLine(c: Context): string | null {
  if (!c) return null;
  const parts: string[] = [];
  if (c.daysOnPlan !== null) parts.push(`${c.daysOnPlan}d on plan`);
  if (c.adherencePercent !== null) {
    parts.push(`${c.adherencePercent}% adherence over ${c.windowDays}d`);
  }
  if (c.painDirection && c.painStart !== null) parts.push(`pain ${c.painStart} → ${c.painEnd}`);
  return parts.length ? parts.join(" · ") : null;
}

export default function ReviewTimeline({
  patientId,
  clinicId,
  /** Bump to refetch — the page increments it whenever a review is recorded. */
  refreshKey,
}: {
  patientId: string;
  clinicId: string;
  refreshKey: number;
}) {
  const [reviews, setReviews] = useState<ReviewRow[] | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/patients/${patientId}/reviews?clinicId=${clinicId}`);
      if (res.ok) setReviews(((await res.json()) as { reviews: ReviewRow[] }).reviews);
    } catch {
      // The page works without history; silence over a broken section.
    }
  }, [patientId, clinicId]);

  useEffect(() => {
    // setState runs inside load() after an await, not in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  if (!reviews || reviews.length === 0) return null;

  return (
    <section className="rounded-xl border border-edge bg-card p-5">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Check-in history
        </h2>
        <span className="text-xs text-muted">
          {reviews.length} decision{reviews.length === 1 ? "" : "s"} {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <ul className="mt-3 space-y-2">
          {reviews.map((r) => {
            const [icon, label] = OUTCOME[r.outcome] ?? ["·", r.outcome];
            const line = contextLine(r.context);
            return (
              <li key={r.id} className="rounded-lg bg-raise/60 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="font-medium">
                    <span className="mr-1.5" aria-hidden>
                      {icon}
                    </span>
                    {label}
                  </span>
                  <span className="text-xs text-muted">
                    {day(r.on)}
                    {r.reviewedByName ? ` · ${r.reviewedByName}` : ""}
                  </span>
                </div>
                {r.note && <p className="mt-0.5">{r.note}</p>}
                {line && <p className="mt-0.5 text-xs text-muted">{line}</p>}
                {r.context?.goals?.length ? (
                  <p className="mt-0.5 text-xs tabular-nums text-muted">
                    {r.context.goals
                      .map(
                        (g) =>
                          `${g.activity}: ${g.baseline}${
                            g.current !== null ? ` → ${g.current}` : ""
                          }`,
                      )
                      .join(" · ")}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
