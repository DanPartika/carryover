// PATCH/DELETE /api/notes/:id — edit, share/unshare, or remove ONE note.
//
// Authorship, not treatment relationship, is the gate here. A clinic admin can
// read the stream, but rewriting or deleting a colleague's clinical note is a
// different act entirely, and nothing in the MVP needs it.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";

const MAX_BODY = 4000;

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
     RETURNING id, body, shared, author_role AS "authorRole", created_at AS "createdAt"`,
    [id, user.id, text ?? null, patch?.shared ?? null],
  );
  if (!note) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ note });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const { rowCount } = await pool.query(
    "DELETE FROM notes WHERE id = $1 AND author_user_id = $2",
    [id, user.id],
  );
  if (!rowCount) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
