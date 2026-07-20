// GET /api/patients — the signed-in PT's assigned patients (clinic admins see
// every patient in their clinics), with episode/plan status for the list view.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";

export async function GET(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { rows } = await pool.query(
    `WITH reachable AS (
       SELECT a.clinic_id, a.patient_user_id
       FROM pt_patients a
       WHERE a.pt_user_id = $1 AND a.active
       UNION
       SELECT m2.clinic_id, m2.user_id AS patient_user_id
       FROM clinic_members me
       JOIN clinic_members m2
         ON m2.clinic_id = me.clinic_id AND m2.role = 'patient' AND m2.active
       WHERE me.user_id = $1 AND me.role = 'admin' AND me.active
     )
     SELECT DISTINCT u.id, u.display_name, u.email, r.clinic_id AS "clinicId",
            c.name AS "clinicName",
            ep.id AS "episodeId", ep.condition,
            (SELECT p.status FROM plans p
             WHERE p.episode_id = ep.id AND p.status IN ('draft','active')
             ORDER BY p.status = 'active' DESC, p.created_at DESC LIMIT 1) AS "planStatus"
     FROM reachable r
     JOIN users u ON u.id = r.patient_user_id
     JOIN clinics c ON c.id = r.clinic_id
     LEFT JOIN episodes ep
       ON ep.patient_user_id = u.id AND ep.clinic_id = r.clinic_id AND ep.closed_at IS NULL
     ORDER BY u.display_name NULLS LAST, u.email`,
    [user.id],
  );

  return NextResponse.json({ patients: rows });
}
