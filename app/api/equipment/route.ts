// GET /api/equipment — the curated equipment catalog (exercise gear + home
// modality devices). Any signed-in user; used by the patient's "my equipment"
// picker.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";

export async function GET(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { rows } = await pool.query(
    "SELECT id, slug, name, kind FROM equipment_catalog ORDER BY kind, name",
  );
  return NextResponse.json({ catalog: rows });
}
