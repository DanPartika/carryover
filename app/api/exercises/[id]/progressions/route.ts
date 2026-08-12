// POST/DELETE /api/exercises/:id/progressions — a PT charting their own chain
// steps ("the next harder step is this"). The authored corridors carry the
// global chains; this is how a clinic's own exercises join them, and how a
// clinic charts a step the corridors don't have.
//
// Edges a clinic writes belong to that clinic (clinic_id, migration 0014):
// they steer that clinic's swap pills and nobody else's, and only their own
// clinic can remove them. Global corridor edges are read-only in-app, the
// same rule as the built-in library rows.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { canManage, rolesInClinic } from "@/lib/auth/roles";
import { getPool } from "@/lib/db/pool";
import { visibleToViewerSql } from "@/lib/library/visibility";

type Body = {
  clinicId?: string;
  toExerciseId?: string;
  direction?: "harder" | "easier";
  note?: string;
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.clinicId || !body?.toExerciseId || !["harder", "easier"].includes(body.direction ?? "")) {
    return NextResponse.json(
      { error: "clinicId, toExerciseId and direction required" },
      { status: 400 },
    );
  }
  if (!canManage(await rolesInClinic(pool, user.id, body.clinicId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (body.toExerciseId === id) {
    return NextResponse.json({ error: "an exercise can't be its own next step" }, { status: 400 });
  }

  // Both ends must be visible to the charting clinic — an edge to an
  // exercise the clinic can't see would put an invisible pill on their plans.
  const { rows: ends } = await pool.query<{ id: string }>(
    `SELECT e.id FROM exercises e
     WHERE e.id = ANY($1::uuid[]) AND e.archived_at IS NULL
       AND ${visibleToViewerSql("$2")}`,
    [[id, body.toExerciseId], [body.clinicId]],
  );
  if (ends.length !== 2) {
    return NextResponse.json({ error: "unknown exercise" }, { status: 400 });
  }

  // direction is from the CURRENT exercise's point of view: "harder" charts
  // this → target, "easier" charts target → this. Edges always store
  // easier → harder.
  const [fromId, toId] =
    body.direction === "harder" ? [id, body.toExerciseId] : [body.toExerciseId, id];

  // Either direction: charting A→B when B→A already exists would give both
  // exercises an "up" pill into each other — a cycle, not a chain.
  const { rows: dupes } = await pool.query(
    `SELECT 1 FROM exercise_progressions
     WHERE ((from_exercise_id = $1 AND to_exercise_id = $2)
         OR (from_exercise_id = $2 AND to_exercise_id = $1))
       AND (clinic_id IS NULL OR clinic_id = $3)`,
    [fromId, toId, body.clinicId],
  );
  if (dupes.length) {
    return NextResponse.json({ error: "that step is already charted" }, { status: 409 });
  }

  // The (from, to) primary key is global, so a conflict here can also mean
  // another clinic privately charted this pair. Single-tenant today; the same
  // message keeps the response from confirming whose edge it is.
  const { rowCount } = await pool.query(
    `INSERT INTO exercise_progressions (from_exercise_id, to_exercise_id, note, clinic_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (from_exercise_id, to_exercise_id) DO NOTHING`,
    [fromId, toId, body.note?.trim().slice(0, 300) || null, body.clinicId],
  );
  if (!rowCount) {
    return NextResponse.json({ error: "that step is already charted" }, { status: 409 });
  }
  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const p = req.nextUrl.searchParams;
  const clinicId = p.get("clinicId");
  const toExerciseId = p.get("toExerciseId");
  const direction = p.get("direction");
  if (!clinicId || !toExerciseId || !["harder", "easier"].includes(direction ?? "")) {
    return NextResponse.json(
      { error: "clinicId, toExerciseId and direction required" },
      { status: 400 },
    );
  }
  if (!canManage(await rolesInClinic(pool, user.id, clinicId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [fromId, toId] = direction === "harder" ? [id, toExerciseId] : [toExerciseId, id];
  // clinic_id in the WHERE is the ownership check: global edges (NULL) and
  // other clinics' edges simply match nothing.
  const { rowCount } = await pool.query(
    `DELETE FROM exercise_progressions
     WHERE from_exercise_id = $1 AND to_exercise_id = $2 AND clinic_id = $3`,
    [fromId, toId, clinicId],
  );
  if (!rowCount) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
