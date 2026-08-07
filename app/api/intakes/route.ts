// POST /api/intakes — record an intake for a patient (PT/admin with a
// treatment relationship). Auto-opens the patient's episode of care on first
// intake (PRD §3: MVP UI auto-creates; the schema supports many).
//
// Since 0011 this is the PT half of a two-sided intake: the patient may have
// pre-filled from Today (POST /api/me/intake), and the PT supersedes that row
// after the in-room review. Field parsing is shared — lib/intake/fields.ts —
// so the two halves can never accept different shapes.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { canTreat } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import {
  INTAKE_INSERT_SQL,
  intakeInsertValues,
  parseIntakeFields,
} from "@/lib/intake/fields";

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const condition = typeof body?.condition === "string" ? body.condition.trim() : "";
  const clinicId = typeof body?.clinicId === "string" ? body.clinicId : "";
  const patientUserId = typeof body?.patientUserId === "string" ? body.patientUserId : "";
  if (!clinicId || !patientUserId || !condition) {
    return NextResponse.json(
      { error: "clinicId, patientUserId, condition required" },
      { status: 400 },
    );
  }
  if (!(await canTreat(pool, user.id, patientUserId, clinicId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const f = parseIntakeFields(body!);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let {
      rows: [episode],
    } = await client.query<{ id: string }>(
      `SELECT id FROM episodes
       WHERE patient_user_id = $1 AND clinic_id = $2 AND closed_at IS NULL
       ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`,
      [patientUserId, clinicId],
    );
    if (!episode) {
      ({
        rows: [episode],
      } = await client.query<{ id: string }>(
        `INSERT INTO episodes (clinic_id, patient_user_id, condition)
         VALUES ($1, $2, $3) RETURNING id`,
        [clinicId, patientUserId, condition],
      ));
    }

    const {
      rows: [intake],
    } = await client.query<{ id: string }>(
      INTAKE_INSERT_SQL,
      intakeInsertValues(episode.id, user.id, condition, f),
    );

    // Age is a user attribute (see 0011) — the PT enters it once, any episode
    // reads it. Only written when the form actually carried a value, so a
    // superseding intake that leaves it blank can't erase what's known.
    if (f.birthYear !== null) {
      await client.query("UPDATE users SET birth_year = $1 WHERE id = $2", [
        f.birthYear,
        patientUserId,
      ]);
    }

    await client.query("COMMIT");
    return NextResponse.json({ episodeId: episode.id, intakeId: intake.id }, { status: 201 });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
