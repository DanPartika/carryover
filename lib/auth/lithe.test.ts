import { describe, expect, it } from "vitest";
import { InMemoryWebStorage, OidcClient, WebStorageStateStore } from "oidc-client-ts";
import { peerIdToken } from "./lithe";

// Picking the id_token_hint for a silent sign-in. Zitadel declines prompt=none
// with interaction_required once the browser remembers more than one account;
// the hint is what tells it which subject we mean, and a sibling Lithe app on
// this origin is where we find one.
const ISSUER = "http://localhost:8080";
const OWN = "383353250289549319";
const STUDIO = "380118453995962370";
const OTHER = "381312712837169154";

function stored(idToken: string, expiresAt?: number): string {
  return JSON.stringify({ id_token: idToken, access_token: "at", expires_at: expiresAt });
}

describe("peerIdToken", () => {
  it("takes a sibling app's token", () => {
    const entries = { [`oidc.user:${ISSUER}:${STUDIO}`]: stored("studio-tok", 100) };
    expect(peerIdToken(entries, ISSUER, OWN)).toBe("studio-tok");
  });

  it("ignores our own client — having no session here is why we're asking", () => {
    const entries = { [`oidc.user:${ISSUER}:${OWN}`]: stored("mine", 100) };
    expect(peerIdToken(entries, ISSUER, OWN)).toBeUndefined();
  });

  it("prefers the freshest sibling", () => {
    const entries = {
      [`oidc.user:${ISSUER}:${STUDIO}`]: stored("older", 100),
      [`oidc.user:${ISSUER}:${OTHER}`]: stored("newer", 999),
    };
    expect(peerIdToken(entries, ISSUER, OWN)).toBe("newer");
  });

  it("ignores a different issuer — its token names a subject Zitadel won't know", () => {
    const entries = { [`oidc.user:https://auth.example.com:${STUDIO}`]: stored("foreign", 100) };
    expect(peerIdToken(entries, ISSUER, OWN)).toBeUndefined();
  });

  it("skips unrelated and malformed keys instead of throwing", () => {
    const entries = {
      "some.other.app": "not json",
      [`oidc.user:${ISSUER}:${STUDIO}`]: "{ half-written",
      [`oidc.user:${ISSUER}:${OTHER}`]: JSON.stringify({ access_token: "no id token" }),
    };
    expect(peerIdToken(entries, ISSUER, OWN)).toBeUndefined();
  });

  it("still returns a token that carries no expiry", () => {
    const entries = { [`oidc.user:${ISSUER}:${STUDIO}`]: stored("no-expiry") };
    expect(peerIdToken(entries, ISSUER, OWN)).toBe("no-expiry");
  });

  it("returns nothing when no app on this origin is signed in", () => {
    expect(peerIdToken({}, ISSUER, OWN)).toBeUndefined();
  });
});

// The silent bounce depends on three things reaching Zitadel's authorize URL.
// id_token_hint in particular is not a first-class signinRedirect argument, so it
// travels as an extra query param — pin that, because losing it silently turns
// every resume back into an account picker.
describe("the silent sign-in request", () => {
  async function signinUrl(): Promise<URL> {
    const client = new OidcClient({
      authority: ISSUER,
      client_id: OWN,
      redirect_uri: "http://127.0.0.1:3006/callback",
      metadata: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth/v2/authorize` },
      stateStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    });
    const request = await client.createSigninRequest({
      prompt: "none",
      url_state: "/history",
      extraQueryParams: { id_token_hint: "peer-token" },
    });
    return new URL(request.url);
  }

  it("carries prompt=none, the id_token_hint, and the return path", async () => {
    const params = (await signinUrl()).searchParams;
    expect(params.get("prompt")).toBe("none");
    expect(params.get("id_token_hint")).toBe("peer-token");
    // oidc-client-ts appends url_state to state after a ";" and hands it back on
    // the callback — including on the error response, which is how a declined
    // resume still returns you to the page you asked for.
    expect(params.get("state")).toContain(";/history");
  });

  it("still uses PKCE", async () => {
    const params = (await signinUrl()).searchParams;
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBeTruthy();
  });
});
