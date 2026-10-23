// GET/POST /api/episodes/:id/documents — files attached to an episode: a
// doctor's plan, a referral, a protocol, a photo of the paper someone was handed.
//
// GET  → { documents, canEdit, limits }. A patient sees only what they attached.
// POST → multipart `file`. Identified from its BYTES (lib/intake/documents), kept
//        in Postgres, capped per file and per episode. Never read by the AI.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";
import { closedEpisodeResponse, isEpisodeClosedError, lockOpenEpisode } from "@/lib/episodes/guard";
import { docActor } from "@/lib/intake/docAccess";
import {
  cleanFilename,
  MAX_DOC_BYTES,
  MAX_DOC_BYTES_PER_EPISODE,
  MAX_DOCS_PER_EPISODE,
  megabytes,
  sniffDocument,
  withExtension,
} from "@/lib/intake/documents";
import { UUID_RE } from "@/lib/review/goal-http";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const actor = UUID_RE.test(id) ? await docActor(pool, id, user.id) : null;
  if (!actor) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { rows: documents } = await pool.query(
    `SELECT d.id, d.filename, d.content_type AS "contentType", d.size_bytes AS "sizeBytes",
            d.uploader_role AS "uploaderRole", (d.uploaded_by = $2) AS mine,
            u.display_name AS "uploaderName", d.created_at AS "createdAt"
     FROM intake_documents d JOIN users u ON u.id = d.uploaded_by
     WHERE d.episode_id = $1 AND d.removed_at IS NULL
       AND ($3::boolean OR d.uploaded_by = $2)
     ORDER BY d.created_at`,
    [id, user.id, actor.role === "pt"],
  );

  return NextResponse.json({
    documents,
    canEdit: !actor.episode.closed,
    limits: { maxBytes: MAX_DOC_BYTES, maxFiles: MAX_DOCS_PER_EPISODE },
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const actor = UUID_RE.test(id) ? await docActor(pool, id, user.id) : null;
  if (!actor) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (actor.episode.closed) return closedEpisodeResponse();

  // Refuse an obviously oversized body before buffering any of it. A small
  // allowance covers the multipart framing around the file itself.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOC_BYTES + 256 * 1024) {
    return NextResponse.json(
      { error: `that file is too large — the limit is ${megabytes(MAX_DOC_BYTES)}` },
      { status: 413 },
    );
  }

  let file: FormDataEntryValue | null;
  try {
    file = (await req.formData()).get("file");
  } catch {
    return NextResponse.json({ error: "couldn't read that upload" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "choose a file to attach" }, { status: 400 });
  }
  if (file.size > MAX_DOC_BYTES) {
    return NextResponse.json(
      { error: `that file is too large — the limit is ${megabytes(MAX_DOC_BYTES)}` },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const filename = cleanFilename(file.name);
  const kind = sniffDocument(bytes, filename);
  if (!kind) {
    return NextResponse.json(
      { error: "that kind of file can't be attached — use a PDF, photo, Word document or text file" },
      { status: 415 },
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await lockOpenEpisode(client, id))) {
      await client.query("ROLLBACK");
      return closedEpisodeResponse();
    }
    // One upload at a time per episode, so the caps below can't both pass.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`intake-docs:${id}`]);
    const {
      rows: [used],
    } = await client.query<{ n: number; total: string }>(
      `SELECT count(*)::int AS n, COALESCE(sum(size_bytes), 0)::bigint AS total
       FROM intake_documents WHERE episode_id = $1 AND removed_at IS NULL`,
      [id],
    );
    if (used.n >= MAX_DOCS_PER_EPISODE) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        {
          error: `a file limit of ${MAX_DOCS_PER_EPISODE} is reached — remove one to attach another`,
          code: "limit",
        },
        { status: 409 },
      );
    }
    if (Number(used.total) + bytes.length > MAX_DOC_BYTES_PER_EPISODE) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "the attached files are already as large as they can be together — remove one first", code: "limit" },
        { status: 409 },
      );
    }
    const {
      rows: [doc],
    } = await client.query(
      `INSERT INTO intake_documents
         (episode_id, uploaded_by, uploader_role, filename, content_type, size_bytes, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, filename, content_type AS "contentType", size_bytes AS "sizeBytes",
                 uploader_role AS "uploaderRole", true AS mine, created_at AS "createdAt"`,
      [id, user.id, actor.role, withExtension(filename, kind.mime), kind.mime, bytes.length, Buffer.from(bytes)],
    );
    await client.query("COMMIT");
    return NextResponse.json({ document: doc }, { status: 201 });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (isEpisodeClosedError(err)) return closedEpisodeResponse();
    throw err;
  } finally {
    client.release();
  }
}
