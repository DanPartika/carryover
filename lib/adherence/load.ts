// Shared adherence loader (PRD build step 5). Both the dashboard GET and the
// AI-summary POST read through this, so the paragraph the model writes can
// never describe different numbers than the ones on screen next to it.
//
// "Today" comes from Postgres, not the Node process or the browser, matching
// the CURRENT_DATE default that adherence_logs.log_date is written with.

import type { Pool } from "pg";
import {
  computeCompliance,
  computePainTrend,
  effectiveWindowDays,
  windowStart,
  type Compliance,
  type PainTrend,
  type StatItem,
  type StatLog,
} from "@/lib/adherence/stats";
import type { FlagEntry } from "@/lib/ai/summary";

export const DEFAULT_WINDOW_DAYS = 28;
const MAX_FLAG_ROWS = 20;

export type AdherenceView = {
  today: string;
  plan: { id: string; approvedOn: string } | null;
  /** Days actually scored: the request's window, clamped to the plan's age. */
  windowDays: number;
  windowFrom: string;
  compliance: Compliance;
  pain: PainTrend;
  flags: FlagEntry[];
  /** Newest adherence_logs.updated_at — the staleness key a stored summary is
   *  compared against. Null when nothing is logged.
   *
   *  Deliberately a STRING, not a Date: node-postgres hands back a JS Date,
   *  which is millisecond-precision, and Postgres timestamps are microsecond.
   *  Round-tripping through Date truncates, so the stored marker lands a few
   *  hundred microseconds BEFORE the log it was taken from and every existing
   *  log then counts as "new since" — the freshness warning would fire on
   *  every summary the moment it was written. Selected as ::text and inserted
   *  back with a cast, the value survives exactly. */
  logsThrough: string | null;
};

export async function loadAdherence(
  pool: Pool,
  episodeId: string,
  requestedDays = DEFAULT_WINDOW_DAYS,
): Promise<AdherenceView> {
  const {
    rows: [{ today }],
  } = await pool.query<{ today: string }>("SELECT CURRENT_DATE::text AS today");

  const {
    rows: [plan],
  } = await pool.query<{ id: string; approvedOn: string }>(
    `SELECT id, approved_at::date::text AS "approvedOn"
     FROM plans WHERE episode_id = $1 AND status = 'active'`,
    [episodeId],
  );

  const empty: AdherenceView = {
    today,
    plan: null,
    windowDays: requestedDays,
    windowFrom: windowStart(requestedDays, today),
    compliance: { scorable: false, expected: 0, completed: 0, percent: null, items: [] },
    pain: { points: [], start: null, end: null, direction: null },
    flags: [],
    logsThrough: null,
  };
  if (!plan) return empty;

  const windowDays = effectiveWindowDays(requestedDays, plan.approvedOn, today);
  const windowFrom = windowStart(windowDays, today);

  const { rows: items } = await pool.query<StatItem>(
    `SELECT pi.id, e.name, pi.frequency_per_week AS "frequencyPerWeek", pi.location
     FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
     WHERE pi.plan_id = $1 ORDER BY pi.sort, e.name`,
    [plan.id],
  );

  const { rows: logs } = await pool.query<StatLog>(
    `SELECT al.plan_item_id AS "planItemId", al.log_date::text AS "logDate",
            al.completed, al.pain
     FROM adherence_logs al
     JOIN plan_items pi ON pi.id = al.plan_item_id
     WHERE pi.plan_id = $1 AND al.log_date BETWEEN $2::date AND $3::date`,
    [plan.id, windowFrom, today],
  );

  const { rows: flagRows } = await pool.query<FlagEntry>(
    `SELECT al.log_date::text AS date, e.name AS exercise, al.pain,
            al.note, al.flag_for_pt AS flagged
     FROM adherence_logs al
     JOIN plan_items pi ON pi.id = al.plan_item_id
     JOIN exercises e ON e.id = pi.exercise_id
     WHERE pi.plan_id = $1 AND al.log_date BETWEEN $2::date AND $3::date
       AND (al.flag_for_pt OR al.note IS NOT NULL)
     ORDER BY al.flag_for_pt DESC, al.log_date DESC
     LIMIT ${MAX_FLAG_ROWS}`,
    [plan.id, windowFrom, today],
  );

  // Taken over the whole plan, not just the window: a revision to an older log
  // is still news the PT's stored summary predates.
  const {
    rows: [{ logsThrough }],
  } = await pool.query<{ logsThrough: string | null }>(
    `SELECT max(al.updated_at)::text AS "logsThrough"
     FROM adherence_logs al JOIN plan_items pi ON pi.id = al.plan_item_id
     WHERE pi.plan_id = $1`,
    [plan.id],
  );

  return {
    today,
    plan,
    windowDays,
    windowFrom,
    compliance: computeCompliance(items, logs, windowDays),
    pain: computePainTrend(logs),
    flags: flagRows,
    logsThrough,
  };
}
