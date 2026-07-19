// POST /api/clinics — create a clinic (app admins only; PRD §1 decision 12:
// clinic entity from day 1, MVP UI assumes one). The creator becomes the
// clinic's first admin member.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { isAppAdmin } from "@/lib/auth/roles";
import { getPool } from "@/lib/db/pool";

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await isAppAdmin(pool, user.id))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { name?: string } | null;
  const name = body?.name?.trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const {
    rows: [clinic],
  } = await pool.query<{ id: string; name: string }>(
    "INSERT INTO clinics (name, created_by) VALUES ($1, $2) RETURNING id, name",
    [name, user.id],
  );
  await pool.query(
    `INSERT INTO clinic_members (clinic_id, user_id, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (clinic_id, user_id, role) DO UPDATE SET active = true`,
    [clinic.id, user.id],
  );

  return NextResponse.json({ clinic }, { status: 201 });
}
