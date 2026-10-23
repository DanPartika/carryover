// Who may touch an episode's attached files, and in what capacity.
//
// Two kinds of caller, one rule each:
//   * the PATIENT of the episode — sees and removes only the files THEY
//     attached. A file a PT attached (the doctor's protocol, with whatever the
//     PT made of it) is the clinic's working paper, not the patient's view.
//   * a PT/admin who treats the patient — sees every file, may remove any.
// Anyone else gets "not found", never "forbidden": a 403 would confirm that the
// episode or the file exists.

import type { Pool } from "pg";
import { canTreat } from "@/lib/auth/treatment";

export type DocActor = {
  episode: { id: string; clinicId: string; patientUserId: string; closed: boolean };
  role: "patient" | "pt";
};

export async function docActor(
  pool: Pool,
  episodeId: string,
  userId: string,
): Promise<DocActor | null> {
  const {
    rows: [e],
  } = await pool.query<{
    id: string;
    clinic_id: string;
    patient_user_id: string;
    closed_at: Date | null;
  }>("SELECT id, clinic_id, patient_user_id, closed_at FROM episodes WHERE id = $1", [episodeId]);
  if (!e) return null;
  const episode = {
    id: e.id,
    clinicId: e.clinic_id,
    patientUserId: e.patient_user_id,
    closed: e.closed_at !== null,
  };
  if (e.patient_user_id === userId) return { episode, role: "patient" };
  if (await canTreat(pool, userId, e.patient_user_id, e.clinic_id)) return { episode, role: "pt" };
  return null;
}
