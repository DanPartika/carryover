// Goal ratings: the intake's limited activities re-rated over time.
//
// The one content rule worth stealing from real progress reports (Medicare
// BPM ch.15 §220.3): speak to EACH goal, an objective number beside the
// prior number. The intake row is the baseline; goal_ratings rows are the
// "now"; nothing here computes a verdict.

import type { Pool } from "pg";
import type { LimitedActivity } from "@/lib/intake/fields";
import type { GoalProgressRow } from "./signals";

/** Single-episode goal rows — the lean read for the patient's Today, where
 *  running the full batched review loader would be six queries for one card. */
export async function goalRows(pool: Pool, episodeId: string): Promise<GoalProgressRow[] | null> {
  const {
    rows: [base],
  } = await pool.query<{ activities: LimitedActivity[]; on: string }>(
    `SELECT limited_activities AS activities, created_at::date::text AS "on"
     FROM intakes
     WHERE episode_id = $1 AND limited_activities IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [episodeId],
  );
  if (!base) return null;

  const {
    rows: [latest],
  } = await pool.query<{ ratings: LimitedActivity[]; on: string }>(
    `SELECT ratings, created_at::date::text AS "on"
     FROM goal_ratings WHERE episode_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [episodeId],
  );

  const key = (s: string) => s.trim().toLowerCase();
  return base.activities.map((a) => {
    const match = latest?.ratings.find((r) => key(r.activity) === key(a.activity));
    return {
      activity: a.activity,
      baseline: a.rating,
      baselineOn: base.on,
      current: match?.rating ?? null,
      currentOn: match ? latest.on : null,
    };
  });
}

/** Keep only ratings that name one of the episode's actual goals — anything
 *  else is a stale client or a made-up activity, dropped either way. */
export function parseRatings(
  raw: unknown,
  goals: GoalProgressRow[],
): LimitedActivity[] {
  if (!Array.isArray(raw)) return [];
  const key = (s: string) => s.trim().toLowerCase();
  const allowed = new Map(goals.map((g) => [key(g.activity), g.activity]));
  const out: LimitedActivity[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const r = entry as Record<string, unknown>;
    const activity = typeof r.activity === "string" ? allowed.get(key(r.activity)) : undefined;
    const rating = Math.round(Number(r.rating));
    if (!activity || seen.has(activity)) continue;
    if (!Number.isFinite(rating) || rating < 0 || rating > 10) continue;
    seen.add(activity);
    out.push({ activity, rating });
  }
  return out;
}

/** Insert one re-rate event. Append-only, same posture as everything else. */
export async function recordRatings(
  pool: Pool,
  episodeId: string,
  authorUserId: string,
  ratings: LimitedActivity[],
): Promise<void> {
  await pool.query(
    `INSERT INTO goal_ratings (episode_id, author_user_id, ratings)
     VALUES ($1, $2, $3)`,
    [episodeId, authorUserId, JSON.stringify(ratings)],
  );
}
