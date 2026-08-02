// Who can see which exercise (Dan's ask #1, decided 2026-08-02).
//
// The library is three things at once and this is the only rule that tells
// them apart:
//   * clinic_id IS NULL  — the built-in library (free-exercise-db + the
//                          authored knee core). Everyone sees it.
//   * shared             — a clinic wrote it and promoted it. Everyone sees it.
//   * clinic_id = yours  — a clinic wrote it and hasn't promoted it. Only that
//                          clinic sees it.
//
// PT-authored exercises start private on purpose. "Stored on the site so other
// PTs can pick it" is the goal, but a library anyone can write to directly
// fills with half-finished entries and one clinic's shorthand; the Share
// button is the moment a PT vouches for one.
//
// Kept in one place because three readers need the identical rule — library
// browse, exercise detail, and the AI's library slice. Any of them drifting
// means either a leak or an exercise the PT can see but the AI can't pick.

import type { Pool } from "pg";

/** Clinics the viewer belongs to in any active role. Patients included: they
 *  read exercise detail from their Today view, and a clinic-private exercise
 *  their own PT prescribed has to render for them. */
export async function viewerClinicIds(pool: Pool, userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ clinic_id: string }>(
    "SELECT DISTINCT clinic_id FROM clinic_members WHERE user_id = $1 AND active",
    [userId],
  );
  return rows.map((r) => r.clinic_id);
}

/** SQL predicate over an `exercises e`, given the bind placeholder holding the
 *  viewer's clinic id array. */
export function visibleToViewerSql(clinicsPlaceholder: string): string {
  return `(e.clinic_id IS NULL OR e.shared OR e.clinic_id = ANY(${clinicsPlaceholder}::uuid[]))`;
}

/** May this user change a library row? Only clinic-authored ones, and only by
 *  someone in that clinic — the built-in library is not editable in-app, so a
 *  typo fix can never silently rewrite what another clinic already prescribed. */
export function canEditExercise(
  exercise: { clinic_id: string | null },
  viewerClinics: string[],
): boolean {
  return exercise.clinic_id !== null && viewerClinics.includes(exercise.clinic_id);
}
