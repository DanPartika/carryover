// What an episode looked like when it closed.
//
// Computed server-side at the moment of closing and frozen into
// episodes.closing_context: adherence logs stay editable after the fact, so
// "how did it go" recomputed in two years would quietly rewrite the record —
// the same rule plan_reviews.context follows for individual check-ins.
//
// Everything here is a measurement. Nothing computes a verdict; whether 41 of 60
// sessions was good enough is for the PT's summary to say, not this module.
//
// Attribution matters because adherence_logs are PATIENT-scoped, not episode-
// scoped: a patient seen at two clinics has one pile of logs. The counts and the
// pain figure below therefore come ONLY from logs tied to this episode's own
// plan items — never from the patient's whole pile — so one clinic's frozen,
// patient-visible record can't be built from another's sessions.

import type { Pool } from "pg";
import { loadAdherence } from "@/lib/adherence/load";
import { computePainTrend, daysBetween } from "@/lib/adherence/stats";
import { APP_DAY, dayOf } from "@/lib/dates";
import { dosageLine, type DosageType } from "@/lib/dosage";
import { goalRows } from "@/lib/review/goals";

/** The summary only has to be non-blank (the database says the same); a
 *  one-line discharge — "did not return" — is a legitimate close. */
export const SUMMARY_MAX = 4000;
export const WATCH_FOR_MAX = 240;

/** A mis-tap can be undone for this long, and only while nothing newer exists. */
export const REOPEN_WINDOW_HOURS = 72;

/** Care that stopped this long ago is closed AS OF its last activity by
 *  default, not as of the day the PT got round to it. */
export const QUIET_DAYS_FOR_BACKDATE = 14;

export type ClosingGoal = {
  activity: string;
  baseline: number;
  current: number | null;
  baselineOn: string;
  currentOn: string | null;
};

export type ClosingContext = {
  /** Shape version, so a reader years from now can tell which fields mean what. */
  version: 1;
  openedOn: string;
  /** The day care ended — which may be earlier than the day it was closed. */
  endedOn: string;
  /** Inclusive of both ends, in the clinic's calendar. */
  daysInCare: number;
  /** Approved plans over the episode — every revision mints one. */
  planVersions: number;
  /** plan_reviews rows: swaps, revamps, additions, edits, "no change today". */
  checkIns: number;
  /** Home sessions vs. the FINAL plan's exercises only, each counted from its
   *  own first approval, at the final frequency (see lib/adherence/load.ts). An
   *  exercise swapped out along the way contributes nothing here — that is why
   *  the label says so. PT-facing: never sent to a patient. All null/zero when
   *  no plan was ever approved. */
  adherence: {
    scorable: boolean;
    completed: number;
    expected: number;
    percent: number | null;
    windowDays: number;
  };
  /** Prescribed sessions only — logs tied to this episode's plan items. */
  sessions: {
    daysLogged: number;
    sessionsLogged: number;
    flagged: number;
    /** Care the patient did on their own. Unattributed (no plan row behind it),
     *  so PT-facing only and labelled as such. */
    selfDirected: number;
  };
  /** Mean of the first vs the second half of the days a pain score was logged
   *  with a prescribed session — NOT first vs last. PT-facing only: the pain
   *  slider starts at 0 and always posts, so an untouched slider logs "no
   *  pain" and drags these toward zero. */
  pain: {
    start: number | null;
    end: number | null;
    direction: "up" | "down" | "flat" | null;
    daysScored: number;
  };
  goals: ClosingGoal[] | null;
  visits: { count: number; firstOn: string | null; lastOn: string | null };
};

export type PlanSnapshotItem = {
  name: string;
  line: string;
  location: "office" | "home" | "both";
  kind: "exercise" | "modality";
};

export type PlanSnapshot = { approvedOn: string; items: PlanSnapshotItem[] };

/** A window long enough that loadAdherence's own clamp to the program's first
 *  approval is what actually bounds it. */
const WHOLE_PROGRAM_DAYS = 3650;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(v: unknown): v is string {
  return typeof v === "string" && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

export async function buildClosingContext(
  pool: Pool,
  episodeId: string,
  /** The day care ended. Clamped into [opened, today]; default today. */
  endedOn?: string,
): Promise<ClosingContext | null> {
  const {
    rows: [ep],
  } = await pool.query<{ patientUserId: string; openedOn: string; today: string }>(
    `SELECT patient_user_id AS "patientUserId",
            ${dayOf("opened_at")}::text AS "openedOn",
            ${APP_DAY}::text AS today
     FROM episodes WHERE id = $1`,
    [episodeId],
  );
  if (!ep) return null;

  let ended = endedOn && isDay(endedOn) ? endedOn : ep.today;
  if (ended > ep.today) ended = ep.today;
  if (ended < ep.openedOn) ended = ep.openedOn;

  // Must run while the plan is still active — the loader has nothing to
  // measure once it retires.
  const view = await loadAdherence(pool, episodeId, WHOLE_PROGRAM_DAYS, ended);

  const goals = await goalRows(pool, episodeId);

  // Logs tied to THIS episode's plan items. The plan item is the attribution:
  // it belongs to exactly one plan, which belongs to exactly one episode.
  const { rows: logs } = await pool.query<{
    logDate: string;
    completed: boolean;
    pain: number | null;
    flagged: boolean;
  }>(
    `SELECT al.log_date::text AS "logDate", al.completed, al.pain,
            al.flag_for_pt AS flagged
     FROM adherence_logs al
     JOIN plan_items pi ON pi.id = al.plan_item_id
     JOIN plans p ON p.id = pi.plan_id
     WHERE p.episode_id = $1 AND al.patient_user_id = $2
       AND al.log_date BETWEEN $3::date AND $4::date`,
    [episodeId, ep.patientUserId, ep.openedOn, ended],
  );
  const done = logs.filter((l) => l.completed);

  const {
    rows: [adhoc],
  } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM adherence_logs al
     WHERE al.patient_user_id = $1 AND al.plan_item_id IS NULL AND al.completed
       AND al.log_date BETWEEN $2::date AND $3::date`,
    [ep.patientUserId, ep.openedOn, ended],
  );

  const pain = computePainTrend(
    done.map((l) => ({ exerciseId: "", logDate: l.logDate, completed: true, pain: l.pain })),
  );

  const {
    rows: [visits],
  } = await pool.query<ClosingContext["visits"]>(
    `SELECT count(*)::int AS count,
            min(${dayOf("started_at")})::text AS "firstOn",
            max(${dayOf("started_at")})::text AS "lastOn"
     FROM visits
     WHERE episode_id = $1 AND ended_at IS NOT NULL
       AND ${dayOf("started_at")} <= $2::date`,
    [episodeId, ended],
  );

  const {
    rows: [counts],
  } = await pool.query<{ planVersions: number; checkIns: number }>(
    `SELECT (SELECT count(*) FROM plans WHERE episode_id = $1 AND approved_at IS NOT NULL)::int
              AS "planVersions",
            (SELECT count(*) FROM plan_reviews WHERE episode_id = $1)::int AS "checkIns"`,
    [episodeId],
  );

  return {
    version: 1,
    openedOn: ep.openedOn,
    endedOn: ended,
    daysInCare: daysBetween(ep.openedOn, ended) + 1,
    planVersions: counts.planVersions,
    checkIns: counts.checkIns,
    adherence: view.plan
      ? {
          scorable: view.compliance.scorable,
          completed: view.compliance.completed,
          expected: view.compliance.expected,
          percent: view.compliance.percent,
          windowDays: view.windowDays,
        }
      : { scorable: false, completed: 0, expected: 0, percent: null, windowDays: 0 },
    sessions: {
      daysLogged: new Set(done.map((l) => l.logDate)).size,
      sessionsLogged: done.length,
      flagged: logs.filter((l) => l.flagged).length,
      selfDirected: adhoc.n,
    },
    pain: {
      start: pain.start,
      end: pain.end,
      direction: pain.direction,
      daysScored: pain.points.length,
    },
    goals: goals
      ? goals.map((g) => ({
          activity: g.activity,
          baseline: g.baseline,
          current: g.current,
          baselineOn: g.baselineOn,
          currentOn: g.currentOn,
        }))
      : null,
    visits,
  };
}

export type ClosingPreview = {
  condition: string;
  today: string;
  /** The newest thing that happened in this episode — a completed log, a
   *  visit, a plan approval, a check-in. Null for an episode nothing happened in. */
  lastActivityOn: string | null;
  /** Where "care ended" starts: today, unless care went quiet long enough ago
   *  that closing as of today would score the weeks the patient was gone. */
  suggestedEndedOn: string;
  openVisit: { id: string; startedOn: string } | null;
  draftPlan: boolean;
  /** Everything below the preview exists to put in front of the PT BEFORE they
   *  write a word: things that would stop the close, or that closing leaves
   *  behind unanswered. */
  raisedHand: { kind: string; note: string | null; on: string } | null;
  hasApprovedPlan: boolean;
  startedOn: string;
};

export async function closingPreview(pool: Pool, episodeId: string): Promise<ClosingPreview | null> {
  const {
    rows: [row],
  } = await pool.query<{
    patientUserId: string;
    condition: string;
    today: string;
    startedOn: string;
    lastActivityOn: string | null;
    hasApprovedPlan: boolean;
    draftPlan: boolean;
  }>(
    `SELECT e.patient_user_id AS "patientUserId", e.condition, ${APP_DAY}::text AS today,
            ${dayOf("e.opened_at")}::text AS "startedOn",
            GREATEST(
              (SELECT max(al.log_date) FROM adherence_logs al
                 JOIN plan_items pi ON pi.id = al.plan_item_id
                 JOIN plans p ON p.id = pi.plan_id
                WHERE p.episode_id = e.id AND al.completed),
              (SELECT max(${dayOf("v.started_at")}) FROM visits v
                WHERE v.episode_id = e.id AND v.ended_at IS NOT NULL),
              (SELECT max(${dayOf("p.approved_at")}) FROM plans p WHERE p.episode_id = e.id),
              (SELECT max(${dayOf("r.created_at")}) FROM plan_reviews r WHERE r.episode_id = e.id)
            )::text AS "lastActivityOn",
            EXISTS (SELECT 1 FROM plans p WHERE p.episode_id = e.id
                     AND p.approved_at IS NOT NULL) AS "hasApprovedPlan",
            EXISTS (SELECT 1 FROM plans p WHERE p.episode_id = e.id
                     AND p.status = 'draft') AS "draftPlan"
     FROM episodes e WHERE e.id = $1`,
    [episodeId],
  );
  if (!row) return null;

  const {
    rows: [visit],
  } = await pool.query<{ id: string; startedOn: string }>(
    `SELECT id, ${dayOf("started_at")}::text AS "startedOn"
     FROM visits WHERE episode_id = $1 AND ended_at IS NULL`,
    [episodeId],
  );

  const {
    rows: [hand],
  } = await pool.query<{ kind: string; note: string | null; on: string }>(
    `SELECT kind, note, ${dayOf("created_at")}::text AS "on"
     FROM checkin_requests WHERE episode_id = $1 AND resolved_at IS NULL`,
    [episodeId],
  );

  const quiet =
    row.lastActivityOn !== null &&
    daysBetween(row.lastActivityOn, row.today) >= QUIET_DAYS_FOR_BACKDATE;

  return {
    condition: row.condition,
    today: row.today,
    lastActivityOn: row.lastActivityOn,
    suggestedEndedOn: quiet && row.lastActivityOn ? row.lastActivityOn : row.today,
    openVisit: visit ?? null,
    draftPlan: row.draftPlan,
    raisedHand: hand ?? null,
    hasApprovedPlan: row.hasApprovedPlan,
    startedOn: row.startedOn,
  };
}

type SnapshotRow = {
  episodeId: string;
  approvedOn: string;
  name: string;
  kind: "exercise" | "modality";
  dosageType: DosageType;
  sets: number | null;
  reps: number | null;
  holdSecs: number | null;
  durationMins: number | null;
  intensity: string | null;
  frequencyPerWeek: number;
  location: "office" | "home" | "both";
};

/** The plan an episode STARTED with and the one it ENDED with, per episode —
 *  "what did we do and how did it end", the part a PT scans first. Chosen by
 *  approval order, not status: closing retires the last plan, so "active"
 *  no longer identifies it. */
export async function planSnapshots(
  pool: Pool,
  episodeIds: string[],
  which: "first" | "last",
): Promise<Map<string, PlanSnapshot>> {
  const out = new Map<string, PlanSnapshot>();
  if (episodeIds.length === 0) return out;

  // "first" is the earliest approval; "last" is the plan recorded at close
  // (closing_plan_id) — approval timestamps are transaction-start times and can
  // tie or invert under concurrent revisions, so they're only the fallback.
  const pickId =
    which === "first"
      ? `(SELECT p.id FROM plans p WHERE p.episode_id = ep.id AND p.approved_at IS NOT NULL
          ORDER BY p.approved_at ASC, p.id LIMIT 1)`
      : `COALESCE(ep.closing_plan_id,
          (SELECT p.id FROM plans p WHERE p.episode_id = ep.id AND p.approved_at IS NOT NULL
           ORDER BY p.approved_at DESC, p.id LIMIT 1))`;

  const { rows } = await pool.query<SnapshotRow>(
    `WITH pick AS (
       SELECT ep.id AS episode_id, ${pickId} AS plan_id
       FROM episodes ep WHERE ep.id = ANY($1::uuid[])
     )
     SELECT pick.episode_id AS "episodeId", ${dayOf("pl.approved_at")}::text AS "approvedOn",
            e.name, e.kind, e.dosage_type AS "dosageType",
            pi.sets, pi.reps, pi.hold_secs AS "holdSecs", pi.duration_mins AS "durationMins",
            pi.intensity, pi.frequency_per_week AS "frequencyPerWeek", pi.location
     FROM pick
     JOIN plans pl ON pl.id = pick.plan_id
     JOIN plan_items pi ON pi.plan_id = pl.id
     JOIN exercises e ON e.id = pi.exercise_id
     ORDER BY pick.episode_id, pi.sort, e.name`,
    [episodeIds],
  );

  for (const r of rows) {
    let snap = out.get(r.episodeId);
    if (!snap) {
      snap = { approvedOn: r.approvedOn, items: [] };
      out.set(r.episodeId, snap);
    }
    snap.items.push({
      name: r.name,
      line: dosageLine(r),
      location: r.location,
      kind: r.kind,
    });
  }
  return out;
}
