// "Login with Lithe" — OIDC (auth code + PKCE) against Lithe's Zitadel, the same
// flow Lithe Studio uses. Browser-only: oidc-client-ts is imported lazily inside
// getManager so this module is safe to load during SSR/prerender.
//
// Config comes from the app's registration in Lithe's registry (Studio → Apps):
//   NEXT_PUBLIC_LITHE_ISSUER     e.g. http://localhost:8080   (Zitadel)
//   NEXT_PUBLIC_LITHE_CLIENT_ID  the OAuth client id minted at registration
//   NEXT_PUBLIC_LITHE_CORE_URL   e.g. http://localhost:3000   (portal origin; nginx proxies /v1)

import type { AuthProvider, AuthSession, LitheEnv, LitheMe } from "./provider";
import { BASE_PATH } from "../config/basePath";

type UserManagerT = import("oidc-client-ts").UserManager;

const DEFAULT_CORE_URL = "http://localhost:8081";

// Studio and every gateway-served app share one origin in prod, but each has its
// own Zitadel client_id and therefore its own oidc-client-ts localStorage key
// ("oidc.user:<issuer>:<client_id>" — the library's default prefix). Logging out
// only ever clears the key of the app you clicked logout in, so Studio's (or
// another app's) session survives untouched — sweeping every oidc.user:* key on
// logout is what makes one logout end every session on this origin.
const OIDC_USER_KEY_PREFIX = "oidc.user:";

function clearAllOidcSessions(): void {
  for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith(OIDC_USER_KEY_PREFIX)) window.localStorage.removeItem(key);
  }
}

// storage fires only in OTHER same-origin tabs, never the one that made the
// change, so this can't loop — it's what lets an already-open tab of a
// different app (or Studio) react immediately to a logout elsewhere instead of
// only catching up on the next navigation. Attached once: createLitheProvider is
// memoized to a single call by getAuthProvider() in provider.ts.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key?.startsWith(OIDC_USER_KEY_PREFIX) && e.newValue === null) {
      window.location.reload();
    }
  });
}

export function createLitheProvider(env: LitheEnv): AuthProvider {
  const coreUrl = (env.coreUrl ?? DEFAULT_CORE_URL).replace(/\/+$/, "");
  let managerPromise: Promise<UserManagerT> | null = null;

  function getManager(): Promise<UserManagerT> {
    if (typeof window === "undefined") {
      return Promise.reject(new Error("Lithe auth is browser-only"));
    }
    if (!managerPromise) {
      managerPromise = import("oidc-client-ts").then(
        ({ UserManager, WebStorageStateStore }) =>
          new UserManager({
            authority: env.issuer!,
            client_id: env.clientId!,
            // Origin varies by entry point (Lithe gateway vs direct port); the
            // base path rides along so the URI matches the app's registration.
            redirect_uri: window.location.origin + BASE_PATH + "/callback",
            post_logout_redirect_uri: window.location.origin + BASE_PATH + "/",
            response_type: "code",
            scope: "openid profile email",
            userStore: new WebStorageStateStore({ store: window.localStorage }),
            // No background iframes (session check / silent renew); re-auth on demand.
            automaticSilentRenew: false,
            monitorSession: false,
          }),
      );
    }
    return managerPromise;
  }

  async function session(): Promise<AuthSession | null> {
    if (typeof window === "undefined") return null;
    const user = await (await getManager()).getUser();
    if (!user || user.expired || !user.access_token) return null;
    return {
      accessToken: user.access_token,
      litheUserId: user.profile.sub,
      email: user.profile.email,
      displayName: user.profile.name ?? user.profile.preferred_username,
    };
  }

  return {
    kind: "lithe",
    enabled: true,
    login: async () => (await getManager()).signinRedirect(),
    completeLogin: async () => {
      await (await getManager()).signinRedirectCallback();
    },
    // Swept BEFORE the redirect (not after) so this app is correctly logged out
    // immediately even if the subsequent Zitadel round-trip fails for any reason.
    logout: async () => {
      clearAllOidcSessions();
      await (await getManager()).signoutRedirect();
    },
    session,
    me: async () => {
      const s = await session();
      if (!s) return null;
      const res = await fetch(`${coreUrl}/v1/me`, {
        headers: { Authorization: `Bearer ${s.accessToken}` },
      });
      if (!res.ok) return null;
      return (await res.json()) as LitheMe;
    },
  };
}
