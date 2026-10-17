// PATCH/DELETE /api/notes/:id — edit, share/unshare, or remove ONE note.
//
// Authorship, not treatment relationship, is the gate here. A clinic admin can
// read the stream, but rewriting or deleting a colleague's clinical note is a
// different act entirely, and nothing in the MVP needs it.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";
import { closedEpisodeResponse } from "@/lib/episodes/guard";

const MAX_BODY = 4000;

/** Zero rows means either "not yours / not there" or "its episode is closed".
 *  Say which — a stale tab needs the code to reload itself. */
async function refusedOrMissing(
  pool: ReturnType<typeof getPool>,
  noteId: string,
  userId: string,
) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM notes n JOIN episodes e ON e.id = n.episode_id
     WHERE n.id = $1 AND n.author_user_id = $2 AND e.closed_at IS NOT NULL`,
    [noteId, userId],
  );
  return rowCount ? closedEpisodeResponse() : NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const patch = (await req.json().catch(() => null)) as
    | { body?: string; shared?: boolean }
    | null;

  const text = patch?.body?.trim().slice(0, MAX_BODY);
  if (patch?.body !== undefined && !text) {
    return NextResponse.json({ error: "note is empty" }, { status: 400 });
  }

  // COALESCE keeps an omitted field untouched. The patient-notes-are-shared
  // CHECK still backstops a `shared: false` aimed at a journal entry — it
  // comes back as a constraint violation rather than a silent hide.
  const {
    rows: [note],
  } = await pool.query(
    `UPDATE notes SET body = COALESCE($3, body), shared = COALESCE($4, shared),
                      updated_at = now()
     WHERE id = $1 AND author_user_id = $2
       -- A closed episode is the record as it stood: its notes can't be edited,
       -- and above all can't be flipped private -> shared into the patient's view.
       AND NOT EXISTS (SELECT 1 FROM episodes e
                       WHERE e.id = notes.episode_id AND e.closed_at IS NOT NULL)
     RETURNING id, body, shared, author_role AS "authorRole", created_at AS "createdAt"`,
    [id, user.id, text ?? null, patch?.shared ?? null],
  );
  if (!note) return refusedOrMissing(pool, id, user.id);
  return NextResponse.json({ note });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const { rowCount } = await pool.query(
    `DELETE FROM notes WHERE id = $1 AND author_user_id = $2
       AND NOT EXISTS (SELECT 1 FROM episodes e
                       WHERE e.id = notes.episode_id AND e.closed_at IS NOT NULL)`,
    [id, user.id],
  );
  if (!rowCount) return refusedOrMissing(pool, id, user.id);
  return NextResponse.json({ ok: true });
}
