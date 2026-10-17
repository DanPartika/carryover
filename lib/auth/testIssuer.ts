// Test helper (not used by the app): a fake Zitadel issuer. It serves a JWKS at /oauth/v2/keys
// and signs JWT access tokens the way Zitadel does, with a `client_id` claim, so the real
// verification code runs end to end with no mocks. Point NEXT_PUBLIC_LITHE_ISSUER at `issuer`
// BEFORE importing lib/auth/server (it reads the issuer at module load).

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

export interface TokenClaims {
  sub?: string;
  /** Omit for the default test client; null leaves the claim out entirely. */
  client_id?: string | null;
  azp?: string;
  /** Seconds from now. Negative = already expired. Default 300. */
  expiresIn?: number;
  /** Sign with a key the JWKS does not publish. */
  wrongKey?: boolean;
}

export interface TestIssuer {
  issuer: string;
  sign(claims?: TokenClaims): Promise<string>;
  close(): Promise<void>;
}

export const TEST_CLIENT_ID = "own-client";

export async function startTestIssuer(): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

  const server: Server = createServer((req, res) => {
    if (req.url === "/oauth/v2/keys") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function sign(claims: TokenClaims = {}): Promise<string> {
    const payload: Record<string, unknown> = {};
    if (claims.client_id !== null) payload.client_id = claims.client_id ?? TEST_CLIENT_ID;
    if (claims.azp) payload.azp = claims.azp;
    const key: CryptoKey = claims.wrongKey ? other.privateKey : privateKey;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setSubject(claims.sub ?? "user-1")
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + (claims.expiresIn ?? 300))
      .sign(key);
  }

  return { issuer, sign, close: () => new Promise((r) => server.close(() => r())) };
}
