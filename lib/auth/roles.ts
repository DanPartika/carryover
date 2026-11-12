// Clinic-role authorization helpers. Roles are APP-managed rows in
// clinic_members (assigned in-app by a PT/admin), not Lithe group projections —
// Lithe supplies identity only (PRD §3).

import type { Pool } from "pg";

export type ClinicRole = "pt" | "patient" | "admin";

export async function rolesInClinic(
  pool: Pool,
  userId: string,
  clinicId: string,
): Promise<ClinicRole[]> {
  const { rows } = await pool.query<{ role: ClinicRole }>(
    `SELECT role FROM clinic_members
     WHERE user_id = $1 AND clinic_id = $2 AND active`,
    [userId, clinicId],
  );
  return rows.map((r) => r.role);
}

/** PTs and clinic admins manage people and assignments; patients do not. */
export function canManage(roles: ClinicRole[]): boolean {
  return roles.includes("pt") || roles.includes("admin");
}

/**
 * Pure: may someone holding `actorRoles` grant or revoke `role` in this clinic?
 *
 * PTs manage the roster — they add patients, add colleagues, and assign who
 * treats whom. The one thing that is not theirs to hand out is `admin`, because
 * an admin reaches every patient in the clinic without an assignment (see
 * canTreat). When any manager could grant any role, a PT could make themselves
 * an admin — or strip the role from the real one — with a single request. The
 * clinic's admins decide who else is one. So can the app admin, provided they are
 * on this clinic's roster (the route checks canManage first) — which is what
 * recovers a clinic whose last admin has left.
 */
export function canChangeRole(
  actorRoles: ClinicRole[],
  actorIsAppAdmin: boolean,
  role: ClinicRole,
): boolean {
  if (role === "admin") return actorRoles.includes("admin") || actorIsAppAdmin;
  return canManage(actorRoles);
}

export async function isAppAdmin(pool: Pool, userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ is_app_admin: boolean }>(
    "SELECT is_app_admin FROM users WHERE id = $1",
    [userId],
  );
  return rows[0]?.is_app_admin ?? false;
}
