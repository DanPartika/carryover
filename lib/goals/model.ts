// Goals: the shared, pure half. Safe to import from client components.
//
// A goal is an everyday activity someone wants back ("sleeping through the
// night"), rated 0-10 by the PATIENT: 0 = can't do it, 10 = no problem. The
// first few come from the intake; more can be added at any point in an episode
// — by the patient on their own, or by the PT in the room — because what people
// care about surfaces over days, not in the first ten minutes. Each goal keeps
// its own baseline (the rating when it was added), so a late goal is measured
// from when it was named, not from the intake.

export const MAX_GOALS = 8;
export const GOAL_TEXT_MAX = 120;

export type GoalSource = "intake" | "patient" | "pt";

/** One comparison key for "is this the same goal": case, edge and inner
 *  whitespace never make two goals. Mirrors the unique index on
 *  episode_goals (lower(btrim(activity))) once text is normalized on write. */
export function goalKey(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Normalize a goal as typed: control characters out, whitespace collapsed,
 *  capped. Null when there is nothing left or the rating isn't a 0-10 whole
 *  number (a missing rating must not quietly become a 0). */
export function parseNewGoal(raw: unknown): { activity: string; rating: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { activity?: unknown; rating?: unknown };
  const activity =
    typeof r.activity === "string"
      ? r.activity.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, GOAL_TEXT_MAX)
      : "";
  if (!activity) return null;
  const given =
    typeof r.rating === "number" || (typeof r.rating === "string" && r.rating.trim() !== "");
  if (!given) return null;
  const rating = Math.round(Number(r.rating));
  if (!Number.isFinite(rating) || rating < 0 || rating > 10) return null;
  return { activity, rating };
}
