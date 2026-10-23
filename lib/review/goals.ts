// Goals: the intake's limited activities, plus any added since, re-rated over
// time.
//
// The one content rule worth stealing from real progress reports (Medicare
// BPM ch.15 §220.3): speak to EACH goal, an objective number beside the
// prior number. A goal's baseline is its rating when it was named — the
// intake row for the first few, the episode_goals row for the rest — and
// goal_ratings rows are the "now". Nothing here computes a verdict.

import type { Pool, PoolClient } from "pg";
import { dayOf } from "@/lib/dates";
import { isEpisodeClosedError, lockOpenEpisode } from "@/lib/episodes/guard";
import { goalKey, MAX_GOALS, type GoalSource } from "@/lib/goals/model";
import type { LimitedActivity } from "@/lib/intake/fields";
import type { GoalProgressRow } from "./signals";

type Db = Pick<Pool, "query">;

/** Every goal for each episode, in the order a person reads them: the intake's
 *  first, then the ones added since, oldest first. Episodes with no goals are
 *  absent from the map. One round of three queries whatever the episode count
 *  — the patients list and the review signal both lean on this. */
export async function goalsForEpisodes(
  db: Db,
  episodeIds: string[],
): Promise<Map<string, GoalProgressRow[]>> {
  const out = new Map<string, GoalProgressRow[]>();
  if (episodeIds.length === 0) return out;

  // The newest intake that carries limited_activities is the baseline for the
  // intake's own goals. Matched by activity TEXT, not index — a superseding
  // intake that reorders its activities must not silently shift the comparison.
  const { rows: intakeRows } = await db.query<{
    episodeId: string;
    activities: LimitedActivity[];
    on: string;
  }>(
    `SELECT DISTINCT ON (episode_id) episode_id AS "episodeId",
            limited_activities AS activities, ${dayOf("created_at")}::text AS "on"
     FROM intakes
     WHERE episode_id = ANY($1::uuid[]) AND limited_activities IS NOT NULL
     ORDER BY episode_id, created_at DESC`,
    [episodeIds],
  );

  const { rows: addedRows } = await db.query<{
    id: string;
    episodeId: string;
    activity: string;
    baseline: number;
    role: "patient" | "pt";
    createdAt: Date;
    on: string;
  }>(
    `SELECT id, episode_id AS "episodeId", activity, baseline,
            author_role AS role, created_at AS "createdAt",
            ${dayOf("created_at")}::text AS "on"
     FROM episode_goals
     WHERE episode_id = ANY($1::uuid[]) AND retired_at IS NULL
     ORDER BY created_at`,
    [episodeIds],
  );

  // Every re-rate row, newest first. A PT can rate ONE goal in the room, so
  // "where does this goal stand" is the newest row that actually contains it —
  // reading only the newest row reported the others as never re-rated.
  const { rows: ratingRows } = await db.query<{
    episodeId: string;
    ratings: LimitedActivity[];
    createdAt: Date;
    on: string;
  }>(
    `SELECT episode_id AS "episodeId", ratings, created_at AS "createdAt",
            ${dayOf("created_at")}::text AS "on"
     FROM goal_ratings
     WHERE episode_id = ANY($1::uuid[])
     ORDER BY created_at DESC`,
    [episodeIds],
  );

  const intakeBy = new Map(intakeRows.map((r) => [r.episodeId, r]));
  const group = <T extends { episodeId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.episodeId);
      if (list) list.push(r);
      else m.set(r.episodeId, [r]);
    }
    return m;
  };
  const addedBy = group(addedRows);
  const ratingsBy = group(ratingRows);

  for (const episodeId of episodeIds) {
    const ratings = ratingsBy.get(episodeId) ?? [];
    // A goal added AFTER some rating row can't have been rated by it; the
    // rows are newest-first, so the first row older than `since` ends the
    // search. (An intake goal passes null: the intake is the beginning.)
    const standing = (activity: string, since: Date | null) => {
      for (const row of ratings) {
        if (since && row.createdAt < since) break;
        const match = row.ratings.find((r) => goalKey(r.activity) === goalKey(activity));
        if (match) return { current: match.rating, currentOn: row.on };
      }
      return { current: null, currentOn: null };
    };

    const rows: GoalProgressRow[] = [];
    const seen = new Set<string>();

    const intake = intakeBy.get(episodeId);
    for (const a of intake?.activities ?? []) {
      const key = goalKey(a.activity);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        id: null,
        source: "intake",
        activity: a.activity,
        baseline: a.rating,
        baselineOn: intake!.on,
        ...standing(a.activity, null),
      });
    }
    for (const g of addedBy.get(episodeId) ?? []) {
      // A later intake can name something already added: the intake's row
      // stands, and the duplicate quietly folds into it.
      const key = goalKey(g.activity);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        id: g.id,
        source: g.role,
        activity: g.activity,
        baseline: g.baseline,
        baselineOn: g.on,
        ...standing(g.activity, g.createdAt),
      });
    }
    if (rows.length > 0) out.set(episodeId, rows);
  }
  return out;
}

/** Single-episode goal rows — the lean read for the patient's Today, where
 *  running the full batched review loader would be six queries for one card. */
export async function goalRows(pool: Db, episodeId: string): Promise<GoalProgressRow[] | null> {
  return (await goalsForEpisodes(pool, [episodeId])).get(episodeId) ?? null;
}

/** Keep only ratings that name one of the episode's actual goals — anything
 *  else is a stale client or a made-up activity, dropped either way. */
export function parseRatings(raw: unknown, goals: GoalProgressRow[]): LimitedActivity[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Map(goals.map((g) => [goalKey(g.activity), g.activity]));
  const out: LimitedActivity[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const r = entry as Record<string, unknown>;
    const activity = typeof r.activity === "string" ? allowed.get(goalKey(r.activity)) : undefined;
    const given = typeof r.rating === "number" || (typeof r.rating === "string" && r.rating.trim() !== "");
    const rating = given ? Math.round(Number(r.rating)) : Number.NaN;
    if (!activity || seen.has(activity)) continue;
    if (!Number.isFinite(rating) || rating < 0 || rating > 10) continue;
    seen.add(activity);
    out.push({ activity, rating });
  }
  return out;
}

/** Insert one re-rate event. Append-only, same posture as everything else. */
export async function recordRatings(
  pool: Db,
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

export type AddGoalResult =
  | { ok: true; id: string }
  | { ok: false; reason: "closed" | "duplicate" | "full" };

/** Name a new goal for an open episode. One transaction: the episode is
 *  share-locked (a concurrent close waits for us, or we see it closed), and an
 *  advisory lock per episode makes the cap and the duplicate check race-free —
 *  two tabs adding the eighth goal can't both succeed. `activity` and `rating`
 *  come pre-cleaned from parseNewGoal. */
export async function addGoal(
  pool: Pool,
  args: {
    episodeId: string;
    authorUserId: string;
    authorRole: Exclude<GoalSource, "intake">;
    activity: string;
    rating: number;
  },
): Promise<AddGoalResult> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await lockOpenEpisode(client, args.episodeId))) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "closed" };
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `episode-goals:${args.episodeId}`,
    ]);
    const existing = (await goalsForEpisodes(client, [args.episodeId])).get(args.episodeId) ?? [];
    if (existing.length >= MAX_GOALS) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "full" };
    }
    if (existing.some((g) => goalKey(g.activity) === goalKey(args.activity))) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "duplicate" };
    }
    const {
      rows: [row],
    } = await client.query<{ id: string }>(
      `INSERT INTO episode_goals (episode_id, activity, baseline, author_user_id, author_role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [args.episodeId, args.activity, args.rating, args.authorUserId, args.authorRole],
    );
    await client.query("COMMIT");
    return { ok: true, id: row.id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (isEpisodeClosedError(err)) return { ok: false, reason: "closed" };
    // The unique index folds case slightly differently from goalKey: a collision
    // it catches is still a duplicate, not a 500.
    if ((err as { code?: string }).code === "23505") return { ok: false, reason: "duplicate" };
    throw err;
  } finally {
    client.release();
  }
}

/** Take a goal off the live list (soft). Only goals added after the intake can
 *  go — the intake's own activities are part of what the PT assessed. A patient
 *  can retire only what they added themselves (`onlyOwn`); a PT can retire any. */
export async function retireGoal(
  pool: Pool,
  args: { episodeId: string; goalId: string; userId: string; onlyOwn: boolean },
): Promise<"ok" | "missing" | "closed"> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await lockOpenEpisode(client, args.episodeId))) {
      await client.query("ROLLBACK");
      return "closed";
    }
    const { rowCount } = await client.query(
      `UPDATE episode_goals SET retired_at = now(), retired_by = $3
       WHERE id = $1 AND episode_id = $2 AND retired_at IS NULL
         AND (NOT $4::boolean OR author_user_id = $3)`,
      [args.goalId, args.episodeId, args.userId, args.onlyOwn],
    );
    await client.query("COMMIT");
    return rowCount === 1 ? "ok" : "missing";
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
