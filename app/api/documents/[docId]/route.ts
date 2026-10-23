// GET/DELETE /api/documents/:docId — download or remove one attached file.
//
// The bytes are served from our own origin, so the response is locked down:
// the type is the one WE chose from the file's contents, it is always a download
// (never rendered inline), `nosniff` stops a browser second-guessing it, and a
// sandboxing CSP means that even a file that somehow slipped through cannot run.
// Removing a file deletes its contents and keeps the row (see migration 0018).

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";
import { closedEpisodeResponse, lockOpenEpisode } from "@/lib/episodes/guard";
import { docActor } from "@/lib/intake/docAccess";
import { attachmentHeader } from "@/lib/intake/documents";
import { UUID_RE } from "@/lib/review/goal-http";

type DocRow = {
  id: string;
  episode_id: string;
  uploaded_by: string;
  filename: string;
  content_type: string;
  data: Buffer | null;
  removed_at: Date | null;
};

/** The document if it exists, is live, and this caller may see it — else null
 *  (one answer for "no such file", "not yours" and "removed"). */
async function visibleDocument(
  pool: ReturnType<typeof getPool>,
  docId: string,
  userId: string,
) {
  if (!UUID_RE.test(docId)) return null;
  const {
    rows: [doc],
  } = await pool.query<DocRow>(
    `SELECT id, episode_id, uploaded_by, filename, content_type, data, removed_at
     FROM intake_documents WHERE id = $1`,
    [docId],
  );
  if (!doc || doc.removed_at) return null;
  const actor = await docActor(pool, doc.episode_id, userId);
  if (!actor) return null;
  // A patient reaches only what they attached themselves.
  if (actor.role === "patient" && doc.uploaded_by !== userId) return null;
  return { doc, actor };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ docId: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { docId } = await ctx.params;
  const found = await visibleDocument(pool, docId, user.id);
  const data = found?.doc.data;
  if (!found || !data) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { doc } = found;

  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": doc.content_type,
      "Content-Length": String(data.length),
      "Content-Disposition": attachmentHeader(doc.filename),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ docId: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { docId } = await ctx.params;
  const found = await visibleDocument(pool, docId, user.id);
  if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (found.actor.episode.closed) return closedEpisodeResponse();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await lockOpenEpisode(client, found.doc.episode_id))) {
      await client.query("ROLLBACK");
      return closedEpisodeResponse();
    }
    await client.query(
      `UPDATE intake_documents
       SET removed_at = now(), removed_by = $2, data = NULL
       WHERE id = $1 AND removed_at IS NULL`,
      [docId, user.id],
    );
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
