// Clinic people management (PRD build step 2). PT/admin members only.
//
// GET  → { members, assignments, candidates }
// POST → { action: "add_member" | "remove_member" | "assign" | "unassign", ... }
//
// "Inviting" someone who has never logged in happens platform-side (Lithe
// Studio invite → Zitadel account → they open Carryover once); they then
// appear under candidates here and get a role.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { canManage, rolesInClinic, type ClinicRole } from "@/lib/auth/roles";
import { getPool } from "@/lib/db/pool";

const ROLES: ClinicRole[] = ["pt", "patient", "admin"];

async function authorize(req: NextRequest, clinicId: string) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return { pool, error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const roles = await rolesInClinic(pool, user.id, clinicId);
  if (!canManage(roles)) {
    return { pool, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { pool, user, error: null };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: clinicId } = await ctx.params;
  const { pool, error } = await authorize(req, clinicId);
  if (error) return error;

  const { rows: members } = await pool.query(
    `SELECT u.id, u.display_name, u.email,
            array_agg(m.role ORDER BY m.role) AS roles
     FROM clinic_members m JOIN users u ON u.id = m.user_id
     WHERE m.clinic_id = $1 AND m.active
     GROUP BY u.id, u.display_name, u.email
     ORDER BY u.display_name NULLS LAST, u.email`,
    [clinicId],
  );

  const { rows: assignments } = await pool.query(
    `SELECT a.pt_user_id AS "ptUserId", pt.display_name AS "ptName",
            a.patient_user_id AS "patientUserId", pat.display_name AS "patientName",
            pat.email AS "patientEmail"
     FROM pt_patients a
     JOIN users pt ON pt.id = a.pt_user_id
     JOIN users pat ON pat.id = a.patient_user_id
     WHERE a.clinic_id = $1 AND a.active
     ORDER BY pt.display_name, pat.display_name`,
    [clinicId],
  );

  const { rows: candidates } = await pool.query(
    `SELECT u.id, u.display_name, u.email FROM users u
     WHERE NOT EXISTS (
       SELECT 1 FROM clinic_members m
       WHERE m.user_id = u.id AND m.clinic_id = $1 AND m.active
     )
     ORDER BY u.display_name NULLS LAST, u.email`,
    [clinicId],
  );

  return NextResponse.json({ members, assignments, candidates });
}

type Action =
  | { action: "add_member"; userId: string; role: ClinicRole }
  | { action: "remove_member"; userId: string; role: ClinicRole }
  | { action: "assign"; ptUserId: string; patientUserId: string }
  | { action: "unassign"; ptUserId: string; patientUserId: string };

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: clinicId } = await ctx.params;
  const { pool, error } = await authorize(req, clinicId);
  if (error) return error;

  const body = (await req.json().catch(() => null)) as Action | null;
  if (!body) return NextResponse.json({ error: "bad request" }, { status: 400 });

  switch (body.action) {
    case "add_member": {
      if (!ROLES.includes(body.role)) {
        return NextResponse.json({ error: "bad role" }, { status: 400 });
      }
      await pool.query(
        `INSERT INTO clinic_members (clinic_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (clinic_id, user_id, role) DO UPDATE SET active = true`,
        [clinicId, body.userId, body.role],
      );
      break;
    }
    case "remove_member": {
      await pool.query(
        `UPDATE clinic_members SET active = false
         WHERE clinic_id = $1 AND user_id = $2 AND role = $3`,
        [clinicId, body.userId, body.role],
      );
      // Dropping a pt/patient role also retires that side's assignments.
      if (body.role === "pt") {
        await pool.query(
          "UPDATE pt_patients SET active = false WHERE clinic_id = $1 AND pt_user_id = $2",
          [clinicId, body.userId],
        );
      } else if (body.role === "patient") {
        await pool.query(
          "UPDATE pt_patients SET active = false WHERE clinic_id = $1 AND patient_user_id = $2",
          [clinicId, body.userId],
        );
      }
      break;
    }
    case "assign": {
      const ptRoles = await rolesInClinic(pool, body.ptUserId, clinicId);
      const patRoles = await rolesInClinic(pool, body.patientUserId, clinicId);
      if (!ptRoles.includes("pt") || !patRoles.includes("patient")) {
        return NextResponse.json(
          { error: "assignment requires an active pt and an active patient in this clinic" },
          { status: 400 },
        );
      }
      await pool.query(
        `INSERT INTO pt_patients (clinic_id, pt_user_id, patient_user_id) VALUES ($1, $2, $3)
         ON CONFLICT (clinic_id, pt_user_id, patient_user_id) DO UPDATE SET active = true`,
        [clinicId, body.ptUserId, body.patientUserId],
      );
      break;
    }
    case "unassign": {
      await pool.query(
        `UPDATE pt_patients SET active = false
         WHERE clinic_id = $1 AND pt_user_id = $2 AND patient_user_id = $3`,
        [clinicId, body.ptUserId, body.patientUserId],
      );
      break;
    }
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
