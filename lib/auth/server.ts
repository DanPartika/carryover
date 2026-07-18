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

import { request } from "node:http";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet, JWTVerifyGetKey } from "jose";

const issuer = process.env.NEXT_PUBLIC_LITHE_ISSUER;
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

export async function verifyLitheToken(
  token: string,
): Promise<{ litheUserId: string } | null> {
  if (!issuer || !token) return null;
  try {
    const { payload } = await jwtVerify(token, await keyGetter(), { issuer });
    return payload.sub ? { litheUserId: payload.sub } : null;
  } catch {
    return null;
  }
}
