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

export async function isAppAdmin(pool: Pool, userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ is_app_admin: boolean }>(
    "SELECT is_app_admin FROM users WHERE id = $1",
    [userId],
  );
  return rows[0]?.is_app_admin ?? false;
}
