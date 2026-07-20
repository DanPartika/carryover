// POST /api/intakes — record an intake for a patient (PT/admin with a
// treatment relationship). Auto-opens the patient's episode of care on first
// intake (PRD §3: MVP UI auto-creates; the schema supports many).

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { canTreat } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";

const REGIONS = new Set([
  "neck", "shoulder", "elbow", "wrist_hand", "spine",
  "core", "hip", "knee", "ankle_foot", "full_body",
]);

type Body = {
  clinicId?: string;
  patientUserId?: string;
  condition?: string;
  bodyRegions?: string[];
  onsetDate?: string | null;
  painNow?: number | null;
  painWorst?: number | null;
  goals?: string;
  restrictions?: string;
  narrative?: string;
};

function intOrNull(v: unknown, lo: number, hi: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Body | null;
  const condition = body?.condition?.trim();
  if (!body?.clinicId || !body.patientUserId || !condition) {
    return NextResponse.json(
      { error: "clinicId, patientUserId, condition required" },
      { status: 400 },
    );
  }
  if (!(await canTreat(pool, user.id, body.patientUserId, body.clinicId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const bodyRegions = (body.bodyRegions ?? []).filter((r) => REGIONS.has(r));
  const onsetDate = body.onsetDate && /^\d{4}-\d{2}-\d{2}$/.test(body.onsetDate)
    ? body.onsetDate
    : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let {
      rows: [episode],
    } = await client.query<{ id: string }>(
      `SELECT id FROM episodes
       WHERE patient_user_id = $1 AND clinic_id = $2 AND closed_at IS NULL
       ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`,
      [body.patientUserId, body.clinicId],
    );
    if (!episode) {
      ({
        rows: [episode],
      } = await client.query<{ id: string }>(
        `INSERT INTO episodes (clinic_id, patient_user_id, condition)
         VALUES ($1, $2, $3) RETURNING id`,
        [body.clinicId, body.patientUserId, condition],
      ));
    }

    const {
      rows: [intake],
    } = await client.query<{ id: string }>(
      `INSERT INTO intakes
         (episode_id, author_user_id, condition, body_regions, onset_date,
          pain_now, pain_worst, goals, restrictions, narrative)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        episode.id,
        user.id,
        condition,
        bodyRegions,
        onsetDate,
        intOrNull(body.painNow, 0, 10),
        intOrNull(body.painWorst, 0, 10),
        body.goals?.trim() || null,
        body.restrictions?.trim() || null,
        body.narrative?.trim() || null,
      ],
    );
    await client.query("COMMIT");
    return NextResponse.json({ episodeId: episode.id, intakeId: intake.id }, { status: 201 });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
