// Visits collection (PRD build step 6, in-office quick mode).
//
// POST /api/visits  {episodeId}  — start a session, or hand back the one
//   already open. Idempotent on purpose: "Start visit" is a big button on a
//   tablet in a treatment room, and a double-tap must not fork the record.
// GET  /api/visits?episodeId=    — visit history with what was done in each.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { episodeForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";

const HISTORY_LIMIT = 20;

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { episodeId?: string } | null;
  if (!body?.episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });
  const episode = await episodeForActor(pool, body.episodeId, user.id);
  if (!episode) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // The partial unique index (one open visit per episode) is the real guard;
  // DO NOTHING + a follow-up read turns a concurrent double-tap into the same
  // answer for both callers instead of a 500 for the loser.
  const { rows: created } = await pool.query<{ id: string }>(
    `INSERT INTO visits (episode_id, pt_user_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING id`,
    [episode.id, user.id],
  );
  if (created.length > 0) {
    return NextResponse.json({ visitId: created[0].id, resumed: false }, { status: 201 });
  }
  const {
    rows: [open],
  } = await pool.query<{ id: string }>(
    "SELECT id FROM visits WHERE episode_id = $1 AND ended_at IS NULL",
    [episode.id],
  );
  return NextResponse.json({ visitId: open.id, resumed: true });
}

export async function GET(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const episodeId = req.nextUrl.searchParams.get("episodeId");
  if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });
  const episode = await episodeForActor(pool, episodeId, user.id);
  if (!episode) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { rows: visits } = await pool.query(
    // startedOn is the day label; startedAt is only for duration. Rendering
    // the timestamp with toLocaleDateString would disagree with the dashboard,
    // which gets its dates from Postgres — an evening visit would show as
    // "Aug 1" in one panel and "Aug 2" in the other, on the same screen.
    `SELECT v.id, v.started_at AS "startedAt", v.started_at::date::text AS "startedOn",
            v.ended_at AS "endedAt", v.note, u.display_name AS "ptName"
     FROM visits v LEFT JOIN users u ON u.id = v.pt_user_id
     WHERE v.episode_id = $1
     ORDER BY v.started_at DESC LIMIT ${HISTORY_LIMIT}`,
    [episodeId],
  );
  const { rows: items } = await pool.query(
    `SELECT vi.visit_id AS "visitId", vi.exercise_id AS "exerciseId", e.name,
            vi.plan_item_id AS "planItemId", vi.sets, vi.reps,
            vi.hold_secs AS "holdSecs", vi.pain, vi.note
     FROM visit_items vi JOIN exercises e ON e.id = vi.exercise_id
     WHERE vi.visit_id = ANY($1::uuid[])
     ORDER BY vi.created_at`,
    [visits.map((v) => v.id)],
  );

  return NextResponse.json({
    visits: visits.map((v) => ({ ...v, items: items.filter((i) => i.visitId === v.id) })),
  });
}
