// Loading the "due for review" signal for one episode or thirty.
//
// Batched on purpose. The patients list needs this for every patient the PT
// can reach, and running the dashboard's per-episode loader N times would be
// dozens of round trips to paint one row of chips. Six queries here, whatever
// N is — and the MATH is the dashboard's math, imported from
// lib/adherence/stats, so the chip on the list and the percentage on the
// patient page can never disagree about the same window.
//
// The window is FIXED at 28 days and deliberately not the panel's window: the
// chip must not appear and disappear as a PT flips the dashboard between 7d
// and 90d. Clamped to the plan's age by the same rule the dashboard uses.

import type { Pool } from "pg";
import {
  computeCompliance,
  computePainTrend,
  effectiveWindowDays,
  windowStart,
  type StatItem,
  type StatLog,
} from "@/lib/adherence/stats";
import type { LimitedActivity } from "@/lib/intake/fields";
import {
  computeReviewSignal,
  reviewClockFrom,
  type CheckinRequest,
  type ReviewSignal,
} from "./due";

export const REVIEW_WINDOW_DAYS = 28;

export type EpisodeReview = ReviewSignal & {
  episodeId: string;
  planId: string | null;
  windowDays: number;
};

/** One intake goal beside where it stands now — the row a progress report is
 *  made of ("stairs: 4/10 at intake → 7/10 last week"). `current` is the
 *  newest re-rate, matched by activity text; null until someone re-rates. */
export type GoalProgressRow = {
  activity: string;
  baseline: number;
  baselineOn: string;
  current: number | null;
  currentOn: string | null;
};

/** The numbers behind a decision, frozen into plan_reviews.context — logs stay
 *  editable, so "what did this look like at the time" has to be stored. */
export type ReviewContext = {
  daysOnPlan: number | null;
  windowDays: number;
  adherencePercent: number | null;
  completed: number;
  expected: number;
  painStart: number | null;
  painEnd: number | null;
  painDirection: string | null;
  triggers: string[];
  /** Goal-by-goal standing at the moment of the decision — the content rule
   *  real progress reports live by: each goal, a number beside a number. */
  goals: GoalProgressRow[] | null;
};

export function reviewContext(r: EpisodeReviewFull | undefined): ReviewContext | null {
  if (!r) return null;
  return {
    daysOnPlan: r.daysOnPlan,
    windowDays: r.windowDays,
    adherencePercent: r.adherencePercent,
    completed: r.completed,
    expected: r.expected,
    painStart: r.painStart,
    painEnd: r.painEnd,
    painDirection: r.painDirection,
    triggers: r.codes,
    goals: r.goals,
  };
}

/** Fields the context snapshot needs that the signal itself doesn't carry. */
type Numbers = {
  adherencePercent: number | null;
  completed: number;
  expected: number;
  painStart: number | null;
  painEnd: number | null;
  painDirection: string | null;
  goals: GoalProgressRow[] | null;
};

export type EpisodeReviewFull = EpisodeReview & Numbers;

export async function reviewSignals(
  pool: Pool,
  episodeIds: string[],
): Promise<Map<string, EpisodeReviewFull>> {
  const out = new Map<string, EpisodeReviewFull>();
  if (episodeIds.length === 0) return out;

  const {
    rows: [{ today }],
  } = await pool.query<{ today: string }>("SELECT CURRENT_DATE::text AS today");

  const { rows: plans } = await pool.query<{
    episodeId: string;
    planId: string;
    approvedOn: string;
    patientUserId: string;
  }>(
    `SELECT p.episode_id AS "episodeId", p.id AS "planId",
            p.approved_at::date::text AS "approvedOn",
            ep.patient_user_id AS "patientUserId"
     FROM plans p JOIN episodes ep ON ep.id = p.episode_id
     WHERE p.episode_id = ANY($1::uuid[]) AND p.status = 'active'`,
    [episodeIds],
  );

  const { rows: reviews } = await pool.query<{ episodeId: string; on: string }>(
    `SELECT DISTINCT ON (episode_id) episode_id AS "episodeId", created_at::date::text AS "on"
     FROM plan_reviews WHERE episode_id = ANY($1::uuid[])
     ORDER BY episode_id, created_at DESC`,
    [episodeIds],
  );
  const lastReview = new Map(reviews.map((r) => [r.episodeId, r.on]));

  const { rows: requests } = await pool.query<CheckinRequest & { episodeId: string }>(
    `SELECT episode_id AS "episodeId", kind, note, created_at::date::text AS "on"
     FROM checkin_requests WHERE episode_id = ANY($1::uuid[]) AND resolved_at IS NULL`,
    [episodeIds],
  );
  const openRequest = new Map(requests.map((r) => [r.episodeId, r]));

  // Completed office visits, dated — counted against each episode's own
  // review clock below (the "every 3 visits" trigger).
  const { rows: visitRows } = await pool.query<{ episodeId: string; on: string }>(
    `SELECT episode_id AS "episodeId", started_at::date::text AS "on"
     FROM visits WHERE episode_id = ANY($1::uuid[]) AND ended_at IS NOT NULL`,
    [episodeIds],
  );
  const visitsByEpisode = new Map<string, string[]>();
  for (const v of visitRows) {
    const list = visitsByEpisode.get(v.episodeId);
    if (list) list.push(v.on);
    else visitsByEpisode.set(v.episodeId, [v.on]);
  }

  // The goals: the newest intake that carries limited_activities is the
  // baseline; the newest goal_ratings row is where they stand. Matched by
  // activity TEXT, not index — a superseding intake that reorders its three
  // activities must not silently shift the comparison.
  const { rows: goalBase } = await pool.query<{
    episodeId: string;
    activities: LimitedActivity[];
    on: string;
  }>(
    `SELECT DISTINCT ON (episode_id) episode_id AS "episodeId",
            limited_activities AS activities, created_at::date::text AS "on"
     FROM intakes
     WHERE episode_id = ANY($1::uuid[]) AND limited_activities IS NOT NULL
     ORDER BY episode_id, created_at DESC`,
    [episodeIds],
  );
  const { rows: goalLatest } = await pool.query<{
    episodeId: string;
    ratings: LimitedActivity[];
    on: string;
  }>(
    `SELECT DISTINCT ON (episode_id) episode_id AS "episodeId",
            ratings, created_at::date::text AS "on"
     FROM goal_ratings WHERE episode_id = ANY($1::uuid[])
     ORDER BY episode_id, created_at DESC`,
    [episodeIds],
  );
  const latestRatings = new Map(goalLatest.map((g) => [g.episodeId, g]));
  const goalsByEpisode = new Map<string, GoalProgressRow[]>();
  for (const base of goalBase) {
    const latest = latestRatings.get(base.episodeId);
    const key = (s: string) => s.trim().toLowerCase();
    goalsByEpisode.set(
      base.episodeId,
      base.activities.map((a) => {
        const match = latest?.ratings.find((r) => key(r.activity) === key(a.activity));
        return {
          activity: a.activity,
          baseline: a.rating,
          baselineOn: base.on,
          current: match?.rating ?? null,
          currentOn: match ? latest!.on : null,
        };
      }),
    );
  }

  // Episodes with no active plan still get a row: a raised hand on a patient
  // between plans is exactly when a PT most needs to hear it.
  for (const episodeId of episodeIds) {
    const signal = computeReviewSignal({
      today,
      planApprovedOn: null,
      lastReviewOn: lastReview.get(episodeId) ?? null,
      windowDays: REVIEW_WINDOW_DAYS,
      compliance: { scorable: false, expected: 0, completed: 0, percent: null, items: [] },
      pain: { points: [], start: null, end: null, direction: null },
      request: openRequest.get(episodeId) ?? null,
      visitsSinceReview: 0,
    });
    out.set(episodeId, {
      ...signal,
      // A request with no plan behind it is still a request.
      due: signal.request !== null,
      episodeId,
      planId: null,
      windowDays: REVIEW_WINDOW_DAYS,
      adherencePercent: null,
      completed: 0,
      expected: 0,
      painStart: null,
      painEnd: null,
      painDirection: null,
      goals: goalsByEpisode.get(episodeId) ?? null,
    });
  }
  if (plans.length === 0) return out;

  const { rows: items } = await pool.query<StatItem & { planId: string }>(
    `SELECT pi.id, pi.plan_id AS "planId", pi.exercise_id AS "exerciseId", e.name,
            pi.frequency_per_week AS "frequencyPerWeek", pi.location
     FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
     WHERE pi.plan_id = ANY($1::uuid[])`,
    [plans.map((p) => p.planId)],
  );

  // Patient-scoped like the dashboard's query: ad-hoc care rows carry pain
  // scores that belong in the trend, and match no plan item so they cannot
  // inflate compliance.
  const { rows: logs } = await pool.query<StatLog & { patientUserId: string }>(
    `SELECT al.patient_user_id AS "patientUserId", al.plan_item_id AS "planItemId",
            al.log_date::text AS "logDate", al.completed, al.pain
     FROM adherence_logs al
     WHERE al.patient_user_id = ANY($1::uuid[])
       AND al.log_date > CURRENT_DATE - $2::int`,
    [[...new Set(plans.map((p) => p.patientUserId))], REVIEW_WINDOW_DAYS],
  );

  for (const plan of plans) {
    const windowDays = effectiveWindowDays(REVIEW_WINDOW_DAYS, plan.approvedOn, today);
    const from = windowStart(windowDays, today);
    const planItems = items.filter((i) => i.planId === plan.planId);
    const planLogs = logs.filter(
      (l) => l.patientUserId === plan.patientUserId && l.logDate >= from && l.logDate <= today,
    );

    const compliance = computeCompliance(planItems, planLogs, windowDays);
    const pain = computePainTrend(planLogs);
    // Strictly after the decision day: a visit on the morning of a review was
    // part of what that review already saw.
    const clockFrom = reviewClockFrom(plan.approvedOn, lastReview.get(plan.episodeId) ?? null);
    const visitsSinceReview = (visitsByEpisode.get(plan.episodeId) ?? []).filter(
      (on) => on > clockFrom,
    ).length;
    const signal = computeReviewSignal({
      today,
      planApprovedOn: plan.approvedOn,
      lastReviewOn: lastReview.get(plan.episodeId) ?? null,
      windowDays,
      compliance,
      pain,
      request: openRequest.get(plan.episodeId) ?? null,
      visitsSinceReview,
    });

    out.set(plan.episodeId, {
      ...signal,
      episodeId: plan.episodeId,
      planId: plan.planId,
      windowDays,
      adherencePercent: compliance.scorable ? compliance.percent : null,
      completed: compliance.completed,
      expected: compliance.expected,
      painStart: pain.start,
      painEnd: pain.end,
      painDirection: pain.direction,
      goals: goalsByEpisode.get(plan.episodeId) ?? null,
    });
  }

  return out;
}
