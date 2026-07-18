// The auth seam (copied from breezy-bets — the de-facto Lithe SDK until
// @lithe/sdk is extracted): every auth flow goes through this interface. Default
// is the disabled provider — the app must boot and fully work with Lithe absent.
// Setting NEXT_PUBLIC_LITHE_ISSUER + NEXT_PUBLIC_LITHE_CLIENT_ID (from registering
// ClientFirst in Lithe's app registry) switches on "Login with Lithe".

import { createLitheProvider } from "./lithe";

export type AuthSession = {
  accessToken: string;
  /** Zitadel `sub` — the lithe_user_id this app links user-owned records to. */
  litheUserId: string;
  email?: string;
  displayName?: string;
};

/** Identity + authorization as Lithe Core reports it (GET /v1/me). */
export type LitheMe = {
  id: string;
  email: string;
  displayName: string;
  tenantId: string;
  groups: { id: string; name: string }[];
};

export interface AuthProvider {
  readonly kind: "none" | "lithe";
  readonly enabled: boolean;
  login(): Promise<void>;
  completeLogin(): Promise<void>;
  logout(): Promise<void>;
  session(): Promise<AuthSession | null>;
  /** Lithe /v1/me — JIT-provisions the user in Lithe and returns groups. */
  me(): Promise<LitheMe | null>;
}

export type LitheEnv = {
  issuer?: string;
  clientId?: string;
  coreUrl?: string;
};

export function litheEnv(): LitheEnv {
  return {
    issuer: process.env.NEXT_PUBLIC_LITHE_ISSUER,
    clientId: process.env.NEXT_PUBLIC_LITHE_CLIENT_ID,
    coreUrl: process.env.NEXT_PUBLIC_LITHE_CORE_URL,
  };
}

/** Lithe login is on only when both the issuer and this app's client id are set. */
export function isLitheConfigured(env: LitheEnv = litheEnv()): boolean {
  return Boolean(env.issuer && env.clientId);
}

const disabled: AuthProvider = {
  kind: "none",
  enabled: false,
  login: async () => {},
  completeLogin: async () => {},
  logout: async () => {},
  session: async () => null,
  me: async () => null,
};

let provider: AuthProvider | null = null;

export function getAuthProvider(): AuthProvider {
  if (!provider) {
    provider = isLitheConfigured() ? createLitheProvider(litheEnv()) : disabled;
  }
  return provider;
}
