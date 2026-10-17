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
import { closedEpisodeResponse } from "@/lib/episodes/guard";
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
  // Starting an episode is an explicit act. A form that was editing an episode
  // says WHICH one (`episodeId`); one opened from "no open episode" says so
  // (`startNew`). Without that, a stale tab saving after the episode was closed
  // elsewhere would silently mint a brand-new episode carrying the old
  // condition, and the PT would believe they had amended the closed one.
  const assertedEpisodeId = typeof body?.episodeId === "string" ? body.episodeId : null;
  if (!assertedEpisodeId && body?.startNew !== true) {
    return NextResponse.json({ error: "episodeId or startNew required" }, { status: 400 });
  }
  if (!(await canTreat(pool, user.id, patientUserId, clinicId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const f = parseIntakeFields(body!);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let episode: { id: string } | undefined;
    if (assertedEpisodeId) {
      // Amending a specific episode: it must still be the open one.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assertedEpisodeId)) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "bad episodeId" }, { status: 400 });
      }
      ({
        rows: [episode],
      } = await client.query<{ id: string }>(
        `SELECT id FROM episodes
         WHERE id = $1 AND patient_user_id = $2 AND clinic_id = $3 AND closed_at IS NULL
         FOR UPDATE`,
        [assertedEpisodeId, patientUserId, clinicId],
      ));
      if (!episode) {
        await client.query("ROLLBACK");
        return closedEpisodeResponse();
      }
    } else {
      // Find the open episode or open one. Two requests can both see "none"
      // (a PT's intake and the patient's own pre-fill); the unique index on open
      // episodes lets exactly one INSERT win and the loser joins the winner's.
      for (let attempt = 0; attempt < 3 && !episode; attempt++) {
        ({
          rows: [episode],
        } = await client.query<{ id: string }>(
          `SELECT id FROM episodes
           WHERE patient_user_id = $1 AND clinic_id = $2 AND closed_at IS NULL
           ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`,
          [patientUserId, clinicId],
        ));
        if (episode) break;
        ({
          rows: [episode],
        } = await client.query<{ id: string }>(
          `INSERT INTO episodes (clinic_id, patient_user_id, condition)
           VALUES ($1, $2, $3)
           ON CONFLICT (clinic_id, patient_user_id) WHERE closed_at IS NULL DO NOTHING
           RETURNING id`,
          [clinicId, patientUserId, condition],
        ));
      }
      if (!episode) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "busy — try again" }, { status: 409 });
      }
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
