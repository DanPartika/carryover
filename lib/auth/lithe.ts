// "Login with Lithe" — OIDC (auth code + PKCE) against Lithe's Zitadel, the same
// flow Lithe Studio uses. Browser-only: oidc-client-ts is imported lazily inside
// getManager so this module is safe to load during SSR/prerender.
//
// Config comes from the app's registration in Lithe's registry (Studio → Apps):
//   NEXT_PUBLIC_LITHE_ISSUER     e.g. http://localhost:8080   (Zitadel)
//   NEXT_PUBLIC_LITHE_CLIENT_ID  the OAuth client id minted at registration
//   NEXT_PUBLIC_LITHE_CORE_URL   e.g. http://localhost:3000   (portal origin; nginx proxies /v1)

import type { AuthProvider, AuthSession, LitheEnv, LitheMe, LoginResult } from "./provider";
import { BASE_PATH, currentRelativePath, safeRelativePath } from "../config/basePath";

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

// Because every app has its own client_id, signing in through Studio (or another
// app) leaves no oidc.user key here and this app boots looking signed out — which
// is the "why am I logging in twice?" complaint. Zitadel still holds the SSO
// session on its own domain, so instead of showing a login button we ask for a
// token with prompt=none: a top-level redirect that either comes straight back
// with a code or answers login_required, and either way the user sees nothing.
// (A hidden iframe is the more usual trick, but the issuer is a different site
// from the gateway, so its cookie would be third-party and increasingly blocked.)
const RESUME_DENIED = "denied";
// Floor between bounces. Nothing should hit it — it exists so that a token which
// somehow comes back already expired can't drive an endless redirect loop.
const RESUME_FLOOR_MS = 10_000;

const NO_SESSION_ERRORS = new Set([
  "login_required",
  "interaction_required",
  "consent_required",
  "account_selection_required",
]);

/** The id_token some OTHER Lithe app on this origin already holds, newest first.
 *
 *  prompt=none on its own is not enough: once the browser remembers more than one
 *  account Zitadel has no way to know which one we mean, so it declines with
 *  interaction_required and would show the account picker. An id_token names the
 *  subject, and passing one as id_token_hint makes the session resolve silently.
 *  Sibling apps are exactly where one is to be found — in prod Studio and every
 *  app share an origin, which is the same fact that lets logout sweep them all. */
export function peerIdToken(
  entries: Record<string, string>,
  issuer: string,
  ownClientId: string,
): string | undefined {
  const prefix = `${OIDC_USER_KEY_PREFIX}${issuer}:`;
  let best: { token: string; expiresAt: number } | undefined;
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith(prefix) || key.slice(prefix.length) === ownClientId) continue;
    try {
      const stored = JSON.parse(value) as { id_token?: unknown; expires_at?: unknown };
      if (typeof stored.id_token !== "string" || !stored.id_token) continue;
      const expiresAt = typeof stored.expires_at === "number" ? stored.expires_at : 0;
      if (!best || expiresAt > best.expiresAt) best = { token: stored.id_token, expiresAt };
    } catch {
      // Not ours, or half-written. A hint is optional; never fail over one.
    }
  }
  return best?.token;
}

function localStorageEntries(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(window.localStorage)) {
    const value = window.localStorage.getItem(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

/** Zitadel answering "nobody is signed in here" to a prompt=none request. The
 *  expected negative, not a broken login. */
function isNoSessionError(err: unknown): boolean {
  const e = err as { error?: unknown; message?: unknown };
  return (
    (typeof e?.error === "string" && NO_SESSION_ERRORS.has(e.error)) ||
    (typeof e?.message === "string" && NO_SESSION_ERRORS.has(e.message))
  );
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

  // Marked per tab (sessionStorage) and per client, since Studio and every app
  // share one origin in prod. Holds RESUME_DENIED once Zitadel has said there is
  // no session — without that the sign-in screen would bounce off Zitadel
  // forever — or the time the last bounce started. A completed sign-in clears
  // it, so a token expiring later in this tab can bounce again instead of
  // dumping the user back on the login screen.
  const resumeKey = `lithe.resume:${env.clientId}`;
  // Lives for this page instance only: React StrictMode runs effects twice in
  // dev, and the second run must not fall through to the sign-in screen while
  // the first is already navigating away.
  let redirecting = false;

  function mayResume(): boolean {
    const mark = window.sessionStorage.getItem(resumeKey);
    if (mark === null) return true;
    if (mark === RESUME_DENIED) return false;
    return Date.now() - Number(mark) > RESUME_FLOOR_MS;
  }

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
    // url_state rides through Zitadel inside the state parameter, so landing on
    // /history signed out returns you to /history rather than the home page.
    login: async () =>
      (await getManager()).signinRedirect({ url_state: currentRelativePath() }),
    resumeSession: async () => {
      if (typeof window === "undefined") return false;
      if (redirecting) return true;
      if (!mayResume()) return false;
      redirecting = true;
      window.sessionStorage.setItem(resumeKey, String(Date.now()));
      // id_token_hint isn't in oidc-client-ts's signinRedirect args, so it rides
      // along as an extra query param — the authorize request is the same either way.
      const hint = peerIdToken(localStorageEntries(), env.issuer!, env.clientId!);
      try {
        await (await getManager()).signinRedirect({
          prompt: "none",
          url_state: currentRelativePath(),
          ...(hint ? { extraQueryParams: { id_token_hint: hint } } : {}),
        });
      } catch (err) {
        // Zitadel unreachable, say. Leave the button as the way in.
        redirecting = false;
        throw err;
      }
      return true;
    },
    completeLogin: async (): Promise<LoginResult> => {
      try {
        const user = await (await getManager()).signinRedirectCallback();
        window.sessionStorage.removeItem(resumeKey);
        return { outcome: "signed-in", returnTo: safeRelativePath(user.url_state) };
      } catch (err) {
        if (!isNoSessionError(err)) throw err;
        // Turned down: stop bouncing in this tab and let the sign-in screen show.
        window.sessionStorage.setItem(resumeKey, RESUME_DENIED);
        const { url_state } = err as { url_state?: unknown };
        return { outcome: "no-session", returnTo: safeRelativePath(url_state) };
      }
    },
    // Swept BEFORE the redirect (not after) so this app is correctly logged out
    // immediately even if the subsequent Zitadel round-trip fails for any reason.
    logout: async () => {
      const mgr = await getManager();
      // Read the id_token BEFORE the sweep: signoutRedirect() looks it up in the
      // very storage clearAllOidcSessions() empties, and would otherwise send the
      // end-session request with no id_token_hint — Zitadel isn't told which
      // session to end and may prompt instead of returning here.
      const idToken = (await mgr.getUser())?.id_token;
      clearAllOidcSessions();
      // The Zitadel session ends with this too, so the bounce back to our home
      // page must not turn around and try to resume it.
      window.sessionStorage.setItem(resumeKey, RESUME_DENIED);
      await mgr.signoutRedirect(idToken ? { id_token_hint: idToken } : undefined);
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
