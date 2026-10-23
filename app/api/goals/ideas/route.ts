// POST /api/goals/ideas — activities a PT might ask a patient about, drafted
// from what the PT has put in the intake. PT/admin only, deliberately: the
// patient-facing suggestions are a fixed list (lib/goals/ideas), and nothing a
// model writes reaches a patient unless a PT chooses it. Changes nothing — it
// reads the posted fields and answers; the PT adds a goal with the add route.
//
// Never a dead end: any model failure answers with the starter list and says so.

import { NextRequest, NextResponse } from "next/server";
import { ideasModel, suggestGoalIdeas } from "@/lib/ai/goals";
import { requireUser } from "@/lib/auth/identity";
import { canManage, rolesInClinic } from "@/lib/auth/roles";
import { getPool } from "@/lib/db/pool";
import { GOAL_TEXT_MAX } from "@/lib/goals/model";
import { REGION_OPTIONS, SIDE_OPTIONS } from "@/lib/intake/fields";

const REGIONS = new Set<string>(REGION_OPTIONS.map(([v]) => v));
const SIDES = new Set<string>(SIDE_OPTIONS.map(([v]) => v));

function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const clinicId = typeof body?.clinicId === "string" ? body.clinicId : null;
  if (!clinicId) return NextResponse.json({ error: "clinicId required" }, { status: 400 });
  if (!canManage(await rolesInClinic(pool, user.id, clinicId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const regions = Array.isArray(body?.bodyRegions)
    ? (body.bodyRegions as unknown[]).filter((r): r is string => typeof r === "string" && REGIONS.has(r))
    : [];
  const existing = Array.isArray(body?.existing)
    ? (body.existing as unknown[])
        .map((e) => text(e, GOAL_TEXT_MAX))
        .filter((e): e is string => !!e)
        .slice(0, 12)
    : [];

  const started = Date.now();
  const result = await suggestGoalIdeas({
    input: {
      condition: text(body?.condition, 300) ?? "",
      side: typeof body?.side === "string" && SIDES.has(body.side) ? body.side : null,
      regions,
      restrictions: text(body?.restrictions, 500),
      assistiveDevice: text(body?.assistiveDevice, 120),
      existing,
    },
    jwt: user.token,
  });

  await pool.query(
    `INSERT INTO ai_call_log (user_id, kind, mode, model, status, latency_ms, error)
     VALUES ($1, 'goal-ideas', $2, $3, $4, $5, $6)`,
    [
      user.id,
      process.env.CARRYOVER_AI_MODE === "lithe" ? "lithe" : "fixture",
      result.model ?? (process.env.CARRYOVER_AI_MODE === "lithe" ? ideasModel() : null),
      result.fellBack ? "error" : "ok",
      Date.now() - started,
      result.reason,
    ],
  );

  return NextResponse.json({ ideas: result.ideas, mode: result.mode, fellBack: result.fellBack });
}
