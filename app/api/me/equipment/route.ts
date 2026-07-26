// POST /api/me/equipment — toggle one item of MY OWN home-equipment
// inventory. Self only: a patient manages their own shelf; a PT sees it
// read-only on the patient overview.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { equipmentId?: string; owned?: boolean }
    | null;
  if (!body?.equipmentId || typeof body.owned !== "boolean") {
    return NextResponse.json({ error: "equipmentId and owned required" }, { status: 400 });
  }

  if (body.owned) {
    await pool.query(
      `INSERT INTO patient_equipment (user_id, equipment_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [user.id, body.equipmentId],
    );
  } else {
    await pool.query(
      "DELETE FROM patient_equipment WHERE user_id = $1 AND equipment_id = $2",
      [user.id, body.equipmentId],
    );
  }
  return NextResponse.json({ ok: true });
}
