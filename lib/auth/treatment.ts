// Treatment-relationship authorization: a PT may act on a patient only when an
// active pt_patients assignment links them in that clinic (clinic admins may
// act on any patient in their clinic). This is the server-side enforcement of
// the many-to-many model — UI hiding is not authorization.

import type { Pool } from "pg";
import { rolesInClinic } from "./roles";

export async function canTreat(
  pool: Pool,
  actorUserId: string,
  patientUserId: string,
  clinicId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM pt_patients
     WHERE clinic_id = $1 AND pt_user_id = $2 AND patient_user_id = $3 AND active`,
    [clinicId, actorUserId, patientUserId],
  );
  if (rows.length > 0) return true;
  const roles = await rolesInClinic(pool, actorUserId, clinicId);
  return roles.includes("admin");
}

/** Resolve an episode and verify the actor may treat its patient. */
export async function episodeForActor(
  pool: Pool,
  episodeId: string,
  actorUserId: string,
): Promise<{ id: string; clinicId: string; patientUserId: string } | null> {
  const { rows } = await pool.query<{
    id: string;
    clinic_id: string;
    patient_user_id: string;
  }>("SELECT id, clinic_id, patient_user_id FROM episodes WHERE id = $1", [episodeId]);
  if (rows.length === 0) return null;
  const e = rows[0];
  if (!(await canTreat(pool, actorUserId, e.patient_user_id, e.clinic_id))) return null;
  return { id: e.id, clinicId: e.clinic_id, patientUserId: e.patient_user_id };
}
