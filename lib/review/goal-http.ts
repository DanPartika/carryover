// The HTTP face of add/retire goal, shared by the patient's routes and the PT's
// so the two can never answer the same situation differently.

import { NextResponse } from "next/server";
import { closedEpisodeResponse } from "@/lib/episodes/guard";
import { MAX_GOALS } from "@/lib/goals/model";
import type { AddGoalResult } from "./goals";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function addGoalResponse(r: AddGoalResult): NextResponse {
  if (r.ok) return NextResponse.json({ ok: true, id: r.id }, { status: 201 });
  if (r.reason === "closed") return closedEpisodeResponse();
  if (r.reason === "duplicate") {
    return NextResponse.json(
      { error: "that goal is already on the list", code: "duplicate" },
      { status: 409 },
    );
  }
  return NextResponse.json(
    {
      error: `a goal list holds ${MAX_GOALS} at a time — remove one to add another`,
      code: "full",
    },
    { status: 409 },
  );
}

export function retireGoalResponse(r: "ok" | "missing" | "closed"): NextResponse {
  if (r === "closed") return closedEpisodeResponse();
  if (r === "missing") return NextResponse.json({ error: "goal not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
