// GET /api/patients/:id/episodes?clinicId= — this clinic's CLOSED episodes of
// care for one patient, newest first: the summary the PT signed, the numbers
// frozen at the time, how the plan started and ended, and the intake it began
// from. "What did we do last time, and how did it end?" in one read.
//
// Clinic-scoped on purpose: canTreat is per clinic, and a patient seen at two
// clinics must not hand one clinic's records to the other.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { canTreat } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import { loadPastEpisodes } from "@/lib/episodes/history";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: patientId } = await ctx.params;
  const clinicId = req.nextUrl.searchParams.get("clinicId");
  if (!clinicId) return NextResponse.json({ error: "clinicId required" }, { status: 400 });
  if (!(await canTreat(pool, user.id, patientId, clinicId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const episodes = await loadPastEpisodes(pool, patientId, clinicId, { withIntake: true });
  return NextResponse.json({ episodes });
}
