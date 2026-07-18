// Shared identity resolution for API routes: verify the Lithe JWT (or the
// dev-user escape hatch when auth is off) and map to our users row. Routes
// other than /api/bootstrap do NOT create users — the app always bootstraps on
// page load, so a missing row means the caller skipped the front door.

import type { NextRequest } from "next/server";
import type { Pool } from "pg";
import { verifyLitheToken } from "./server";

export type RouteUser = {
  id: string; // users.id (uuid)
  litheUserId: string;
  token: string; // raw JWT ("" for the dev user) — forwarded to /v1/ai and /v1/me
};

export async function requireUser(req: NextRequest, pool: Pool): Promise<RouteUser | null> {
  let litheUserId: string;
  let token = "";

  if (process.env.NEXT_PUBLIC_LITHE_ISSUER) {
    const header = req.headers.get("authorization") ?? "";
    token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const verified = await verifyLitheToken(token);
    if (!verified) return null;
    litheUserId = verified.litheUserId;
  } else if (process.env.CARRYOVER_ALLOW_DEV_USER) {
    litheUserId = "dev-user"; // dead branch once an issuer is configured
  } else {
    return null;
  }

  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE lithe_user_id = $1",
    [litheUserId],
  );
  if (rows.length === 0) return null; // bootstrap first
  return { id: rows[0].id, litheUserId, token };
}
