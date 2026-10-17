// POST /api/episodes/:id/close {summary, watchFor?, endedOn?, aiAssisted?, basis?}
// — end an episode of care.
//
// The summary IS the close: no summary, no close. The PT wrote or edited it and
// pressed the button, which is the approval (doctrine #1) — the same way the
// one-tap progression swap is. From this moment the patient can read it, the
// episode is read-only, and the patient's Today has no plan until a new episode
// opens.
//
// One transaction, under the episode row's FOR UPDATE lock so it serializes
// with every other writer (lib/episodes/guard.ts + the 0016 trigger):
//   - refuse if a visit is still open;
//   - freeze the numbers while the plan is still active (the loader has
//     nothing to measure after it retires), and refuse if they moved since the
//     PT looked (`basis`) — the summary they signed describes THAT record;
//   - retire the active plan and remember which one it was;
//   - stamp the episode, and append what was published to episode_closures.
//
// Deliberately NOT done, because each would be a silent side effect the PT
// can't see and a reopen couldn't undo: discarding an unapproved draft plan
// (it stays, inert), and marking the patient's raised hand answered (nobody
// answered it — it stays open, and the preview showed it to the PT).

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { episodeForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import {
  buildClosingContext,
  closingPreview,
  isDay,
  SUMMARY_MAX,
  WATCH_FOR_MAX,
} from "@/lib/episodes/closing";

type Basis = { planVersions: number; checkIns: number; sessionsLogged: number; visits: number };

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as {
    summary?: unknown;
    watchFor?: unknown;
    endedOn?: unknown;
    aiAssisted?: unknown;
    basis?: Partial<Basis> | null;
  } | null;

  const summary = typeof body?.summary === "string" ? body.summary.trim() : "";
  if (!summary) {
    return NextResponse.json({ error: "write a summary first" }, { status: 400 });
  }
  if (summary.length > SUMMARY_MAX) {
    return NextResponse.json(
      { error: `the summary is too long — keep it under ${SUMMARY_MAX} characters` },
      { status: 400 },
    );
  }
  const watchFor = typeof body?.watchFor === "string" ? body.watchFor.trim() : "";
  if (watchFor.length > WATCH_FOR_MAX) {
    return NextResponse.json(
      { error: `keep "watch for" to one short line (${WATCH_FOR_MAX} characters)` },
      { status: 400 },
    );
  }

  const episode = await episodeForActor(pool, id, user.id);
  if (!episode) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const preview = await closingPreview(pool, episode.id);
  if (!preview) return NextResponse.json({ error: "not found" }, { status: 404 });

  let endedOn = preview.suggestedEndedOn;
  if (body?.endedOn !== undefined && body.endedOn !== null && body.endedOn !== "") {
    if (!isDay(body.endedOn) || body.endedOn < preview.startedOn || body.endedOn > preview.today) {
      return NextResponse.json(
        { error: "care can't have ended before it started or after today" },
        { status: 400 },
      );
    }
    endedOn = body.endedOn;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      rows: [locked],
    } = await client.query<{
      closed_at: Date | null;
      closed_by: string | null;
      closing_summary: string | null;
    }>("SELECT closed_at, closed_by, closing_summary FROM episodes WHERE id = $1 FOR UPDATE", [
      episode.id,
    ]);
    if (!locked) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (locked.closed_at) {
      await client.query("ROLLBACK");
      // A double-tap, or a retry after a dropped response, lands here with the
      // exact request that already succeeded. That's a success, not an error.
      if (locked.closed_by === user.id && locked.closing_summary === summary) {
        return NextResponse.json({ ok: true, already: true });
      }
      return NextResponse.json(
        { error: "this episode was already closed", code: "episode_closed" },
        { status: 409 },
      );
    }

    const { rowCount: openVisits } = await client.query(
      "SELECT 1 FROM visits WHERE episode_id = $1 AND ended_at IS NULL",
      [episode.id],
    );
    if (openVisits) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "a visit is still open — end it before closing the episode", code: "open_visit" },
        { status: 409 },
      );
    }

    // Frozen from a separate connection: it only reads, and MVCC readers are
    // not blocked by the row lock this transaction holds.
    const context = await buildClosingContext(pool, episode.id, endedOn);
    if (!context) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    // The summary the PT signed describes the record THEY looked at. If it moved
    // since — a patient logged, a visit ended, a plan revised in another tab —
    // refuse and hand back the fresh numbers instead of filing a summary that
    // contradicts the stats printed beside it.
    const b = body?.basis;
    if (
      b &&
      (b.planVersions !== context.planVersions ||
        b.checkIns !== context.checkIns ||
        b.sessionsLogged !== context.sessions.sessionsLogged ||
        b.visits !== context.visits.count)
    ) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        {
          error:
            "the record changed since you drafted this — check the numbers, then close again",
          code: "stale_basis",
          context,
        },
        { status: 409 },
      );
    }

    const {
      rows: [retired],
    } = await client.query<{ id: string }>(
      `UPDATE plans SET status = 'retired', retired_at = clock_timestamp()
       WHERE episode_id = $1 AND status = 'active' RETURNING id`,
      [episode.id],
    );

    const {
      rows: [closed],
    } = await client.query<{ closedAt: string }>(
      `UPDATE episodes
       SET closed_at = clock_timestamp(), closed_by = $2, ended_on = $3::date,
           closing_summary = $4, closing_watch_for = $5, closing_ai_assisted = $6,
           closing_context = $7::jsonb, closing_plan_id = $8
       WHERE id = $1
       RETURNING closed_at::text AS "closedAt"`,
      [
        episode.id,
        user.id,
        context.endedOn,
        summary,
        watchFor || null,
        body?.aiAssisted === true,
        JSON.stringify(context),
        retired?.id ?? null,
      ],
    );

    await client.query(
      `INSERT INTO episode_closures
         (episode_id, closed_by, closed_at, ended_on, summary, watch_for, ai_assisted, context)
       VALUES ($1, $2, $3::timestamptz, $4::date, $5, $6, $7, $8::jsonb)`,
      [
        episode.id,
        user.id,
        closed.closedAt,
        context.endedOn,
        summary,
        watchFor || null,
        body?.aiAssisted === true,
        JSON.stringify(context),
      ],
    );

    await client.query("COMMIT");
    return NextResponse.json({ ok: true, closedAt: closed.closedAt });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
