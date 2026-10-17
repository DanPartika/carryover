import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestIssuer, TEST_CLIENT_ID, type TestIssuer } from "./testIssuer";

// verifyLitheToken end to end against a fake Zitadel: real JWKS fetch, real
// signature check, no mocks. server.ts reads its env when first imported, so the
// env is stubbed before each import.

let issuer: TestIssuer;
let server: typeof import("./server");
let unconfigured: typeof import("./server");

beforeAll(async () => {
  issuer = await startTestIssuer();
  vi.stubEnv("NEXT_PUBLIC_LITHE_ISSUER", issuer.issuer);
  vi.stubEnv("NEXT_PUBLIC_LITHE_CLIENT_ID", TEST_CLIENT_ID);
  vi.resetModules();
  server = await import("./server");

  vi.stubEnv("NEXT_PUBLIC_LITHE_CLIENT_ID", "");
  vi.resetModules();
  unconfigured = await import("./server");
  vi.unstubAllEnvs();
});
afterAll(() => issuer.close());

describe("verifyLitheToken", () => {
  it("accepts a token minted by this app's own client", async () => {
    const t = await issuer.sign({ sub: "dan-sub" });
    expect(await server.verifyLitheToken(t)).toEqual({ litheUserId: "dan-sub" });
  });

  it("rejects a valid token minted for ANOTHER Lithe app", async () => {
    // Cryptographically perfect, right issuer, not expired — and still refused.
    const t = await issuer.sign({ sub: "dan-sub", client_id: "breezy-bets-client" });
    expect(await server.verifyLitheToken(t)).toBeNull();
  });

  it("rejects a token with no client binding at all", async () => {
    const t = await issuer.sign({ sub: "dan-sub", client_id: null });
    expect(await server.verifyLitheToken(t)).toBeNull();
  });

  it("fails closed when this app's client id isn't configured", async () => {
    const t = await issuer.sign({ sub: "dan-sub" });
    expect(await unconfigured.verifyLitheToken(t)).toBeNull();
  });

  it("still rejects bad signatures and expired tokens", async () => {
    expect(await server.verifyLitheToken(await issuer.sign({ sub: "dan-sub", wrongKey: true }))).toBeNull();
    expect(await server.verifyLitheToken(await issuer.sign({ sub: "dan-sub", expiresIn: -60 }))).toBeNull();
    expect(await server.verifyLitheToken("not-a-jwt")).toBeNull();
  });
});
