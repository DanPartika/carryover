import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { User, UserManager } from "oidc-client-ts";
import { createLitheProvider } from "./lithe";

// Logout must hand Zitadel an id_token_hint. clearAllOidcSessions() empties the
// very storage signoutRedirect() reads the id_token from, so the token has to be
// read BEFORE the sweep and passed explicitly. All seven Lithe apps (and Studio)
// shipped the wrong order until 2026-10-16: end-session went out with no hint, so
// Zitadel wasn't told which session to end.

const ISSUER = "http://auth.test";
const CLIENT = "own-client";

// A localStorage stand-in whose entries are own enumerable properties, so
// Object.keys(window.localStorage) — what the sweep iterates — sees them.
class MemStorage {
  getItem(k: string) {
    return Object.prototype.hasOwnProperty.call(this, k) ? (this as unknown as Record<string, string>)[k] : null;
  }
  setItem(k: string, v: string) {
    (this as unknown as Record<string, string>)[k] = String(v);
  }
  removeItem(k: string) {
    delete (this as unknown as Record<string, string>)[k];
  }
  key(i: number) {
    return Object.keys(this)[i] ?? null;
  }
  get length() {
    return Object.keys(this).length;
  }
}

let local: MemStorage;
let signout: MockInstance<UserManager["signoutRedirect"]>;

beforeEach(() => {
  local = new MemStorage();
  vi.stubGlobal("window", {
    localStorage: local,
    sessionStorage: new MemStorage(),
    location: { origin: "http://app.test", pathname: "/", search: "", hash: "" },
  });
  // The redirect itself is the one thing not exercised: capture its arguments.
  signout = vi.spyOn(UserManager.prototype, "signoutRedirect").mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function storeLogin(client: string, idToken: string) {
  const user = new User({
    id_token: idToken,
    access_token: "at",
    token_type: "Bearer",
    profile: { sub: "dan", iss: ISSUER, aud: client, exp: 0, iat: 0 },
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  local.setItem(`oidc.user:${ISSUER}:${client}`, user.toStorageString());
}

describe("logout", () => {
  it("passes this app's id_token as id_token_hint, and still clears every session", async () => {
    storeLogin(CLIENT, "my-id-token");
    storeLogin("studio-client", "studio-id-token");

    await createLitheProvider({ issuer: ISSUER, clientId: CLIENT }).logout();

    expect(signout).toHaveBeenCalledTimes(1);
    expect(signout.mock.calls[0][0]).toEqual({ id_token_hint: "my-id-token" });
    // The one-logout-ends-every-app sweep still happens.
    expect(Object.keys(local).filter((k) => k.startsWith("oidc.user:"))).toEqual([]);
  });

  it("with no session here, logs out without inventing a hint", async () => {
    await createLitheProvider({ issuer: ISSUER, clientId: CLIENT }).logout();
    expect(signout).toHaveBeenCalledTimes(1);
    expect(signout.mock.calls[0][0]).toBeUndefined();
  });
});
