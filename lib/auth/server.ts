// Server-side verification of a Lithe (Zitadel) access token — the real enforcement
// behind "logged-in users only". The client gate in RequireAuth is UX; anything that
// touches the DB or spends money must land here. Zitadel-minted access tokens are
// JWTs (Lithe registers apps with accessTokenType JWT), so we verify signature +
// issuer against its JWKS.
//
// Inside a container the public issuer host (e.g. localhost:8080) isn't reachable.
// Set LITHE_ISSUER_INTERNAL_URL (e.g. http://zitadel:8080) and the JWKS is fetched
// from that address while keeping the external Host header — the same dial-rewrite
// trick Lithe Core uses. Uses node:http because undici's fetch silently drops Host
// overrides, and Zitadel resolves its instance by Host. Token `iss` claims are
// validated against the public issuer either way.
//
// ── Only tokens minted for THIS app ─────────────────────────────────────────────
// Lithe Core verifies member-route tokens with SkipClientIDCheck: true, so a token
// minted for ANY registered client is a valid Lithe token. breezy-bets is a PUBLIC
// app — anyone can log into it and walk away with a token that would otherwise open
// this one, skipping the portal's group gating entirely. So this app also requires
// the token was minted by ITS OWN client, exactly as Core's requireAdmin and the
// ledger/warroom apps do. Added 2026-10-16 in the platform-wide fix-it pass.
//
// Studio's Data tab is unaffected: app/api/admin/query asks Core /v1/me about the
// caller, it never comes through verifyLitheToken.

import { request } from "node:http";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet, JWTPayload, JWTVerifyGetKey } from "jose";

const issuer = process.env.NEXT_PUBLIC_LITHE_ISSUER;
const clientId = process.env.NEXT_PUBLIC_LITHE_CLIENT_ID;
const internalUrl = process.env.LITHE_ISSUER_INTERNAL_URL;

const JWKS_PATH = "/oauth/v2/keys";
const JWKS_MAX_AGE_MS = 10 * 60_000; // keys rotate rarely; refetch at most this often

let getKey: JWTVerifyGetKey | null = null;
let fetchedAt = 0;

function fetchInternalJwks(): Promise<JSONWebKeySet> {
  const external = new URL(issuer!);
  const internal = new URL(internalUrl!);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: internal.hostname,
        port: internal.port || 80,
        path: JWKS_PATH,
        headers: { Host: external.host },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`JWKS fetch ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(data) as JSONWebKeySet);
          } catch (e) {
            reject(e as Error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function keyGetter(): Promise<JWTVerifyGetKey> {
  if (!internalUrl) {
    getKey ??= createRemoteJWKSet(new URL(issuer!.replace(/\/+$/, "") + JWKS_PATH));
    return getKey;
  }
  if (!getKey || Date.now() - fetchedAt > JWKS_MAX_AGE_MS) {
    getKey = createLocalJWKSet(await fetchInternalJwks());
    fetchedAt = Date.now();
  }
  return getKey;
}

/**
 * Pure: the client id a token was minted for. Zitadel emits `client_id`; `azp` is
 * the OIDC-standard spelling. Core reads them in this order (firstNonEmpty in
 * core/server.go) and so do we.
 */
export function tokenClientId(payload: JWTPayload): string {
  const claims = payload as { client_id?: unknown; azp?: unknown };
  if (typeof claims.client_id === "string" && claims.client_id) return claims.client_id;
  if (typeof claims.azp === "string" && claims.azp) return claims.azp;
  return "";
}

/**
 * Pure: was this token minted by OUR client?
 *
 *  1. Matched via the client_id/azp claim ONLY — **never** `aud`. Zitadel stamps
 *     every app's client id into every token's audience list, so an aud check
 *     would accept a token minted for any app in the project.
 *  2. **Fails closed.** An unset expected client id rejects everything rather
 *     than waving everything through. A misconfigured deploy must not become an
 *     open one.
 */
export function isOwnClientToken(
  tokenClient: string,
  expectedClientId: string | undefined,
): boolean {
  return Boolean(expectedClientId) && tokenClient === expectedClientId;
}

export async function verifyLitheToken(
  token: string,
): Promise<{ litheUserId: string } | null> {
  if (!issuer || !token) return null;
  try {
    const { payload } = await jwtVerify(token, await keyGetter(), { issuer });
    // Signature + issuer + expiry prove Lithe minted it — not that it was minted
    // for US. See the header comment.
    if (!isOwnClientToken(tokenClientId(payload), clientId)) return null;
    return payload.sub ? { litheUserId: payload.sub } : null;
  } catch {
    return null;
  }
}
