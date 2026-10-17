// GET /api/me/episodes — the signed-in PATIENT's own closed episodes of care:
// the summary their PT signed, plus the plain counts behind it. Self-scoped by
// identity — no id in the URL, nothing to authorize against another patient.
//
// The shape is an allowlist (lib/episodes/history.ts forPatient): no adherence
// score, no flags, no intake, no notes, nothing from plans.ai_note.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { dayOf } from "@/lib/dates";
import { getPool } from "@/lib/db/pool";
import { forPatient, loadPastEpisodes } from "@/lib/episodes/history";

export async function GET(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const episodes = await loadPastEpisodes(pool, user.id, null, { withIntake: false });

  // Only what the PT chose to share (`n.shared`), only theirs (`pt`), filtered
  // in SQL: the shape the browser receives must not contain a private note.
  const { rows: notes } = episodes.length
    ? await pool.query<{ episodeId: string; on: string; body: string }>(
        `SELECT n.episode_id AS "episodeId", ${dayOf("n.created_at")}::text AS "on", n.body
         FROM notes n
         WHERE n.episode_id = ANY($1::uuid[]) AND n.shared AND n.author_role = 'pt'
         ORDER BY n.created_at DESC`,
        [episodes.map((e) => e.id)],
      )
    : { rows: [] };

  return NextResponse.json({
    episodes: episodes.map((e) =>
      forPatient(
        e,
        notes.filter((n) => n.episodeId === e.id).map((n) => ({ on: n.on, body: n.body })),
      ),
    ),
  });
}
