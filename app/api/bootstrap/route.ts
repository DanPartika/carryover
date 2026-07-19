// POST /api/bootstrap — called on every session load (clientfirst pattern):
// verify the JWT server-side, forward the same token to Lithe's GET /v1/me
// (which JIT-provisions the user platform-side), upsert our users row, and
// return the app profile the UI boots from: user + clinic memberships.
//
// Unlike clientfirst's cohorts, clinic roles here are APP-managed (a PT/admin
// assigns them in-app, build step 2) — /v1/me supplies identity only, so there
// is no group-projection reconcile.

import { NextRequest, NextResponse } from "next/server";
import { verifyLitheToken } from "@/lib/auth/server";
import { getPool } from "@/lib/db/pool";

// Server-side app→Core calls ride Docker DNS (LITHE_CORE_INTERNAL_URL, set by
// compose); host-run dev falls back to the public Core URL.
const coreUrl = (
  process.env.LITHE_CORE_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_LITHE_CORE_URL ||
  "http://localhost:8081"
).replace(/\/+$/, "");

type Identity = {
  litheUserId: string;
  email: string;
  displayName: string;
};

async function resolveIdentity(req: NextRequest): Promise<Identity | null> {
  if (process.env.NEXT_PUBLIC_LITHE_ISSUER) {
    const header = req.headers.get("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const verified = await verifyLitheToken(token);
    if (!verified) return null;

    let email = "";
    let displayName = "";
    try {
      const res = await fetch(`${coreUrl}/v1/me`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (res.ok) {
        const me = (await res.json()) as { email?: string; displayName?: string };
        email = me.email ?? "";
        displayName = me.displayName ?? "";
      }
    } catch {
      // Core down: still bootstrap from the verified token.
    }
    return { litheUserId: verified.litheUserId, email, displayName };
  }

  // Standalone dev only. The issuer check above means this branch is dead the
  // moment Lithe auth is configured — the escape hatch cannot bypass real auth.
  if (process.env.CARRYOVER_ALLOW_DEV_USER) {
    return {
      litheUserId: "dev-user",
      email: "dev@localhost",
      displayName: "Dev User",
    };
  }
  return null;
}

export type Membership = {
  clinicId: string;
  clinicName: string;
  role: "pt" | "patient" | "admin";
};

export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  const {
    rows: [user],
  } = await pool.query<{
    id: string;
    email: string | null;
    display_name: string | null;
    is_app_admin: boolean;
  }>(
    `INSERT INTO users (lithe_user_id, email, display_name, last_login_at)
     VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), now())
     ON CONFLICT (lithe_user_id) DO UPDATE
       SET email        = COALESCE(NULLIF(EXCLUDED.email, ''), users.email),
           display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), users.display_name),
           last_login_at = now()
     RETURNING id, email, display_name, is_app_admin`,
    [identity.litheUserId, identity.email, identity.displayName],
  );

  // App-admin grant: emails listed in CARRYOVER_ADMIN_EMAILS get is_app_admin
  // on login (idempotent). The standalone dev user is always admin — dev only,
  // that branch is dead once an issuer is configured.
  if (!user.is_app_admin) {
    const adminEmails = (process.env.CARRYOVER_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const email = (user.email ?? "").toLowerCase();
    if (identity.litheUserId === "dev-user" || (email && adminEmails.includes(email))) {
      await pool.query("UPDATE users SET is_app_admin = true WHERE id = $1", [user.id]);
      user.is_app_admin = true;
    }
  }

  const { rows: memberships } = await pool.query<Membership>(
    `SELECT c.id AS "clinicId", c.name AS "clinicName", m.role
     FROM clinic_members m
     JOIN clinics c ON c.id = m.clinic_id
     WHERE m.user_id = $1 AND m.active AND c.archived_at IS NULL
     ORDER BY c.name, m.role`,
    [user.id],
  );

  return NextResponse.json({
    user: {
      id: user.id,
      litheUserId: identity.litheUserId,
      email: user.email ?? "",
      displayName: user.display_name ?? "",
      isAppAdmin: user.is_app_admin,
    },
    memberships,
  });
}
