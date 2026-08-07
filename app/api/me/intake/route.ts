// GET/POST /api/me/intake — the patient's half of the intake, filled from
// Today BEFORE the first visit. Real clinics hand the clipboard to the
// patient in the waiting room; this is that clipboard, at home.
//
// Self-scoped by identity. The patient's submission is an ordinary intakes
// row (author = the patient); the PT supersedes it after the in-room review,
// same append-only model as everything else. Two rules keep the lanes clean:
// the patient can't overwrite a PT-authored intake, and once a plan is
// active, plan-fit feedback goes through the raise-a-hand check-in instead.
// `restrictions` (precautions, weight-bearing) is PT territory — forced null
// here no matter what the request carries.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";
import {
  INTAKE_INSERT_SQL,
  INTAKE_SELECT_COLS,
  intakeInsertValues,
  parseIntakeFields,
} from "@/lib/intake/fields";

type EpisodeRow = { id: string; clinic_id: string; active_plan: boolean };

async function loadState(pool: ReturnType<typeof getPool>, userId: string) {
  const {
    rows: [episode],
  } = await pool.query<EpisodeRow>(
    `SELECT e.id, e.clinic_id,
            EXISTS (SELECT 1 FROM plans p WHERE p.episode_id = e.id AND p.status = 'active')
              AS active_plan
     FROM episodes e
     WHERE e.patient_user_id = $1 AND e.closed_at IS NULL
     ORDER BY e.opened_at DESC LIMIT 1`,
    [userId],
  );

  const { rows: intakes } = episode
    ? await pool.query(
        `SELECT ${INTAKE_SELECT_COLS}
         FROM intakes i WHERE i.episode_id = $1
         ORDER BY i.created_at DESC LIMIT 1`,
        [episode.id],
      )
    : { rows: [] };
  const intake = (intakes[0] as { authorUserId: string } | undefined) ?? null;

  return { episode: episode ?? null, intake };
}

export async function GET(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { episode, intake } = await loadState(pool, user.id);

  const {
    rows: [me],
  } = await pool.query<{ birth_year: number | null }>(
    "SELECT birth_year FROM users WHERE id = $1",
    [user.id],
  );

  let state: "no_clinic" | "none" | "submitted" | "reviewed" | "planned";
  if (episode?.active_plan) state = "planned";
  else if (intake) state = intake.authorUserId === user.id ? "submitted" : "reviewed";
  else if (episode) state = "none";
  else {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM clinic_members
       WHERE user_id = $1 AND role = 'patient' AND active LIMIT 1`,
      [user.id],
    );
    state = rowCount ? "none" : "no_clinic";
  }

  return NextResponse.json({ state, intake, birthYear: me?.birth_year ?? null });
}

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const condition = typeof body?.condition === "string" ? body.condition.trim() : "";
  if (!condition) {
    return NextResponse.json({ error: "tell us what's going on first" }, { status: 400 });
  }
  const f = parseIntakeFields(body!);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let {
      rows: [episode],
    } = await client.query<EpisodeRow>(
      `SELECT e.id, e.clinic_id,
              EXISTS (SELECT 1 FROM plans p WHERE p.episode_id = e.id AND p.status = 'active')
                AS active_plan
       FROM episodes e
       WHERE e.patient_user_id = $1 AND e.closed_at IS NULL
       ORDER BY e.opened_at DESC LIMIT 1 FOR UPDATE OF e`,
      [user.id],
    );

    if (episode?.active_plan) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "your plan is already underway — use the check-in below instead" },
        { status: 409 },
      );
    }

    if (episode) {
      const {
        rows: [latest],
      } = await client.query<{ author_user_id: string }>(
        `SELECT author_user_id FROM intakes
         WHERE episode_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [episode.id],
      );
      if (latest && latest.author_user_id !== user.id) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: "your PT has already completed your intake" },
          { status: 409 },
        );
      }
    } else {
      // No episode yet — open one in the clinic this patient belongs to.
      // Prefer the clinic where a PT is actually assigned to them; a patient
      // in no clinic at all has nowhere to intake into.
      const {
        rows: [clinic],
      } = await client.query<{ clinic_id: string }>(
        `SELECT cm.clinic_id
         FROM clinic_members cm
         LEFT JOIN pt_patients pp
           ON pp.clinic_id = cm.clinic_id AND pp.patient_user_id = cm.user_id AND pp.active
         WHERE cm.user_id = $1 AND cm.role = 'patient' AND cm.active
         ORDER BY (pp.clinic_id IS NOT NULL) DESC, cm.created_at DESC
         LIMIT 1`,
        [user.id],
      );
      if (!clinic) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "no clinic yet — ask your PT" }, { status: 403 });
      }
      ({
        rows: [episode],
      } = await client.query<EpisodeRow>(
        `INSERT INTO episodes (clinic_id, patient_user_id, condition)
         VALUES ($1, $2, $3) RETURNING id, clinic_id, false AS active_plan`,
        [clinic.clinic_id, user.id, condition],
      ));
    }

    const {
      rows: [intake],
    } = await client.query<{ id: string }>(
      INTAKE_INSERT_SQL,
      intakeInsertValues(episode.id, user.id, condition, f, { restrictions: null }),
    );

    if (f.birthYear !== null) {
      await client.query("UPDATE users SET birth_year = $1 WHERE id = $2", [
        f.birthYear,
        user.id,
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
