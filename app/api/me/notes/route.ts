// The patient's journal (PRD build step 7). Self-scoped by identity.
//
// GET  — my own entries plus the PT notes my PT chose to share. Private PT
//        notes are filtered in SQL, not in the client: the shape the browser
//        receives must not contain a note the patient isn't allowed to read.
// POST — write an entry. Always PT-visible; the schema CHECK enforces it too.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";

const MAX_BODY = 4000;
const LIMIT = 100;

/** The patient's current open episode — the only one they can write against. */
async function openEpisodeFor(
  pool: ReturnType<typeof getPool>,
  patientUserId: string,
): Promise<string | null> {
  const {
    rows: [ep],
  } = await pool.query<{ id: string }>(
    `SELECT id FROM episodes WHERE patient_user_id = $1 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [patientUserId],
  );
  return ep?.id ?? null;
}

export async function GET(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { rows } = await pool.query(
    `SELECT n.id, n.body, n.author_role AS "authorRole", n.created_at AS "createdAt",
            u.display_name AS "authorName", (n.author_user_id = $1) AS "mine"
     FROM notes n
     JOIN episodes ep ON ep.id = n.episode_id
     LEFT JOIN users u ON u.id = n.author_user_id
     -- n.shared alone, deliberately. An "OR author_user_id = $1" reads like a
     -- harmless "you can see your own writing" clause, but patient journal
     -- entries are already shared=true, so the only thing it ever adds is a
     -- PRIVATE PT note written by someone who is both the clinician and the
     -- patient — which is exactly how this app gets dogfooded, and it showed
     -- the private note under the patient's journal. This endpoint means
     -- "what a patient may see", so that is all it asks for.
     WHERE ep.patient_user_id = $1 AND n.shared
     ORDER BY n.created_at DESC LIMIT ${LIMIT}`,
    [user.id],
  );
  return NextResponse.json({ notes: rows });
}

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { body?: string } | null;
  const text = body?.body?.trim().slice(0, MAX_BODY);
  if (!text) return NextResponse.json({ error: "note is empty" }, { status: 400 });

  const episodeId = await openEpisodeFor(pool, user.id);
  if (!episodeId) return NextResponse.json({ error: "no open episode" }, { status: 400 });

  const {
    rows: [note],
  } = await pool.query(
    `INSERT INTO notes (episode_id, author_user_id, author_role, body, shared)
     VALUES ($1, $2, 'patient', $3, true)
     RETURNING id, body, author_role AS "authorRole", created_at AS "createdAt",
               true AS "mine"`,
    [episodeId, user.id, text],
  );
  return NextResponse.json({ note }, { status: 201 });
}
