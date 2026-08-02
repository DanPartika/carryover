// PT notes (PRD build step 7).
//
// GET  /api/notes?episodeId=  — the whole stream for an episode: the PT's own
//   notes, private and shared, plus the patient's journal entries.
// POST /api/notes {episodeId, body, shared?, visitId?} — write one. Private by
//   default; sharing is always a deliberate act.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { episodeForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";

const MAX_BODY = 4000;
const LIMIT = 100;

export async function GET(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const episodeId = req.nextUrl.searchParams.get("episodeId");
  if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });
  if (!(await episodeForActor(pool, episodeId, user.id))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { rows } = await pool.query(
    `SELECT n.id, n.body, n.shared, n.author_role AS "authorRole",
            n.author_user_id AS "authorUserId", n.visit_id AS "visitId",
            n.created_at AS "createdAt", u.display_name AS "authorName",
            (n.author_user_id = $2) AS "mine"
     FROM notes n LEFT JOIN users u ON u.id = n.author_user_id
     WHERE n.episode_id = $1
     ORDER BY n.created_at DESC LIMIT ${LIMIT}`,
    [episodeId, user.id],
  );
  return NextResponse.json({ notes: rows });
}

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    episodeId?: string;
    body?: string;
    shared?: boolean;
    visitId?: string | null;
  } | null;
  if (!body?.episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });
  const text = body.body?.trim().slice(0, MAX_BODY);
  if (!text) return NextResponse.json({ error: "note is empty" }, { status: 400 });

  const episode = await episodeForActor(pool, body.episodeId, user.id);
  if (!episode) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // No "you can't write about yourself" check here on purpose. episodeForActor
  // already requires an active assignment or clinic-admin role, which a plain
  // patient never has — so the only person such a rule would block is someone
  // who is genuinely both, which is exactly how this app gets dogfooded.

  // A visit id is only meaningful on this episode; one from elsewhere would
  // file a note under another patient's session.
  let visitId: string | null = null;
  if (body.visitId) {
    const { rows } = await pool.query("SELECT 1 FROM visits WHERE id = $1 AND episode_id = $2", [
      body.visitId,
      episode.id,
    ]);
    if (rows.length === 0) {
      return NextResponse.json({ error: "visit is not on this episode" }, { status: 400 });
    }
    visitId = body.visitId;
  }

  const {
    rows: [note],
  } = await pool.query(
    `INSERT INTO notes (episode_id, author_user_id, author_role, body, shared, visit_id)
     VALUES ($1, $2, 'pt', $3, $4, $5)
     RETURNING id, body, shared, author_role AS "authorRole",
               author_user_id AS "authorUserId", visit_id AS "visitId",
               created_at AS "createdAt", true AS "mine"`,
    [episode.id, user.id, text, body.shared === true, visitId],
  );
  return NextResponse.json({ note }, { status: 201 });
}
