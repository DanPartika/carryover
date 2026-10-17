// The cross-app token gate. A regression here means a token from breezy-bets — a
// PUBLIC Lithe app — opens this one, skipping the portal's group gating.

import { describe, expect, it } from "vitest";
import { isOwnClientToken, tokenClientId } from "./server";

const OURS = "our-client-id";
const THEIRS = "breezy-bets-client-id";

describe("tokenClientId", () => {
  it("reads Zitadel's client_id claim", () => {
    expect(tokenClientId({ client_id: OURS })).toBe(OURS);
  });

  it("falls back to the OIDC-standard azp claim", () => {
    expect(tokenClientId({ azp: OURS })).toBe(OURS);
  });

  it("prefers client_id over azp, matching Core's firstNonEmpty order", () => {
    expect(tokenClientId({ client_id: OURS, azp: THEIRS })).toBe(OURS);
  });

  it("returns empty when neither claim is present or usable", () => {
    expect(tokenClientId({})).toBe("");
    expect(tokenClientId({ client_id: "" })).toBe("");
    expect(tokenClientId({ client_id: 42 as unknown as string })).toBe("");
  });
});

describe("isOwnClientToken", () => {
  it("accepts a token minted by our own client", () => {
    expect(isOwnClientToken(OURS, OURS)).toBe(true);
  });

  it("rejects a token minted by another registered app", () => {
    // The whole point: Core's SkipClientIDCheck makes this token cryptographically
    // valid. Only this check keeps it out.
    expect(isOwnClientToken(THEIRS, OURS)).toBe(false);
  });

  it("fails closed when our client id is unset", () => {
    // A misconfigured deploy must not become an open one.
    expect(isOwnClientToken(OURS, undefined)).toBe(false);
    expect(isOwnClientToken(OURS, "")).toBe(false);
    expect(isOwnClientToken("", undefined)).toBe(false);
  });

  it("rejects a token carrying no client claim at all", () => {
    expect(isOwnClientToken("", OURS)).toBe(false);
  });
});
