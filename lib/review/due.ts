// Is this plan due for a check-in? (Dan's ask #2.)
//
// Pure functions, no DB and no clock — same posture as lib/adherence/stats.ts,
// and it consumes that module's output so the chip and the dashboard can never
// be reading different numbers.
//
// THE RULE, decided 2026-08-02: the app surfaces the signal, never the verdict.
// This module answers "is there something here worth a PT's attention, and what
// is it" — never "progress this patient". The trigger codes below are internal
// (they decide whether to raise the chip and are useful in tests); the only
// thing rendered is `line`, which is measurements and nothing else. If you ever
// find yourself wanting to put "ready to progress" in that string, don't: which
// door to walk through is the PT's call.
//
// Four triggers, composing into ONE chip rather than four badges:
//   time        — the plan has simply been running a while
//   steady      — doing the work, pain settled
//   struggling  — not doing the work, or pain climbing
//   requested   — the patient raised a hand

import { daysBetween, type Compliance, type PainTrend } from "@/lib/adherence/stats";

/** A plan running this long is worth a look regardless of the numbers. */
export const REVIEW_AFTER_DAYS = 21;
/** Data triggers stay quiet until there's enough of a plan behind them to read. */
export const DATA_TRIGGER_MIN_DAYS = 10;
export const STEADY_ADHERENCE = 80;
export const STRUGGLING_ADHERENCE = 50;
/** Pain at or under this counts as settled for the "steady" trigger. */
export const SETTLED_PAIN = 4;
/** Below this the reason line reports no percentage at all. A daily exercise
 *  on a plan approved this morning is already "0% of 1 expected session", which
 *  is arithmetically true and clinically meaningless — and printing it as the
 *  justification for a chip invites a PT to read a failure that hasn't had a
 *  chance to happen. Seven days is the shortest window the dashboard itself
 *  offers, so it's the shortest one worth quoting. */
export const MIN_SCORABLE_DAYS = 7;

export type ReviewCode = "time" | "steady" | "struggling" | "requested";

export type CheckinRequest = {
  kind: "too_easy" | "too_hard" | "something_changed";
  note: string | null;
  on: string; // yyyy-mm-dd
};

export type ReviewInput = {
  today: string;
  /** Null when there's no active plan — nothing to review yet. */
  planApprovedOn: string | null;
  /** Date of the last review of any outcome, including "no change today". */
  lastReviewOn: string | null;
  windowDays: number;
  compliance: Compliance;
  pain: PainTrend;
  request: CheckinRequest | null;
};

export type ReviewSignal = {
  due: boolean;
  codes: ReviewCode[];
  /** The chip's reason line: facts only. Empty when nothing is due. */
  line: string;
  daysOnPlan: number | null;
  /** Days since the last decision — the plan's approval counts as one. */
  daysSinceReview: number | null;
  request: CheckinRequest | null;
};

function days(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

/** The measurements behind the chip, in the order a PT reads them. Never a
 *  recommendation — "24 days on this plan · 92% adherence over 28 days ·
 *  pain 4 → 2" tells the PT what happened and lets them decide what it means. */
export function reasonLine(input: ReviewInput, daysOnPlan: number): string {
  const parts: string[] = [];
  parts.push(daysOnPlan <= 1 ? "approved today" : `${days(daysOnPlan)} on this plan`);
  if (input.windowDays < MIN_SCORABLE_DAYS) {
    parts.push("too new to score");
  } else if (input.compliance.scorable) {
    parts.push(`${input.compliance.percent}% adherence over ${days(input.windowDays)}`);
  } else {
    parts.push("not yet scorable");
  }
  if (input.pain.direction) {
    parts.push(`pain ${input.pain.start} → ${input.pain.end}`);
  } else if (input.pain.points.length > 0) {
    parts.push(`pain scored ${days(input.pain.points.length)}, no trend yet`);
  } else {
    parts.push("no pain scores");
  }
  return parts.join(" · ");
}

export function computeReviewSignal(input: ReviewInput): ReviewSignal {
  const { today, planApprovedOn, lastReviewOn, compliance: c, pain, request } = input;

  if (!planApprovedOn) {
    return {
      due: false,
      codes: [],
      line: "",
      daysOnPlan: null,
      daysSinceReview: null,
      request,
    };
  }

  // Inclusive of the approval day, matching effectiveWindowDays. The two sit
  // one above the other on the patient page — "24 days on this plan" over
  // "25 days, not the full 28" reads as an off-by-one bug even though both
  // conventions were defensible. The scoring window's convention wins.
  const daysOnPlan = daysBetween(planApprovedOn, today) + 1;
  // The clock runs from the last DECISION, not from the plan, and counts
  // elapsed days. A PT who looked yesterday and chose to change nothing should
  // not be told again today.
  const clockFrom =
    lastReviewOn && lastReviewOn > planApprovedOn ? lastReviewOn : planApprovedOn;
  const daysSinceReview = daysBetween(clockFrom, today);

  const codes: ReviewCode[] = [];

  // A raised hand is always news: reviewing resolves any open request, so one
  // that is still open by definition post-dates the last decision.
  if (request) codes.push("requested");

  if (daysSinceReview >= REVIEW_AFTER_DAYS) codes.push("time");

  if (daysSinceReview >= DATA_TRIGGER_MIN_DAYS) {
    const adherence = c.scorable ? (c.percent ?? 0) : null;
    if (
      adherence !== null &&
      adherence >= STEADY_ADHERENCE &&
      pain.direction !== null &&
      pain.direction !== "up" &&
      (pain.end ?? 10) <= SETTLED_PAIN
    ) {
      codes.push("steady");
    }
    // Either half is enough. Pain climbing matters even when the patient is
    // doing every session, and a plan going undone matters even without a
    // pain score to explain it.
    if ((adherence !== null && adherence < STRUGGLING_ADHERENCE) || pain.direction === "up") {
      codes.push("struggling");
    }
  }

  return {
    due: codes.length > 0,
    codes,
    line: codes.length > 0 ? reasonLine(input, daysOnPlan) : "",
    daysOnPlan,
    daysSinceReview,
    request,
  };
}

/** What the patient's raised hand says, in their framing rather than ours. */
export function requestLabel(kind: CheckinRequest["kind"]): string {
  switch (kind) {
    case "too_easy":
      return "this feels too easy now";
    case "too_hard":
      return "this is too much right now";
    default:
      return "something has changed";
  }
}
