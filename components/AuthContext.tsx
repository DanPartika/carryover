"use client";

// Session state for "Login with Lithe". When Lithe isn't configured (no
// NEXT_PUBLIC_LITHE_* env), enabled=false and the app runs standalone —
// the AccountControl renders nothing and no auth code runs.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getAuthProvider, type AuthSession, type LitheMe } from "@/lib/auth/provider";

interface AuthState {
  enabled: boolean;
  /** True until the stored session (if any) has been checked on mount. */
  loading: boolean;
  session: AuthSession | null;
  /** Lithe /v1/me — identity + groups; null until loaded or when logged out. */
  me: LitheMe | null;
  login: () => void;
  logout: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthContextProvider({ children }: { children: React.ReactNode }) {
  const auth = getAuthProvider();
  const [loading, setLoading] = useState(auth.enabled);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [me, setMe] = useState<LitheMe | null>(null);

  useEffect(() => {
    if (!auth.enabled) return;
    let alive = true;
    (async () => {
      try {
        const s = await auth.session();
        if (!alive) return;
        setSession(s);
        if (s) {
          // JIT-provisions this user in Lithe and returns their groups.
          const m = await auth.me();
          if (alive) setMe(m);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [auth]);

  const value = useMemo<AuthState>(
    () => ({
      enabled: auth.enabled,
      loading,
      session,
      me,
      login: () => void auth.login(),
      logout: () => {
        setSession(null);
        setMe(null);
        void auth.logout();
      },
    }),
    [auth, loading, session, me],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthContextProvider");
  return ctx;
}

/** Header chip: "Log in" when signed out, name + sign-out when signed in.
 *  Renders nothing when Lithe isn't configured. */
export function AccountControl() {
  const { enabled, loading, session, login, logout } = useAuth();
  if (!enabled || loading) return null;

  if (!session) {
    return (
      <button
        onClick={login}
        className="rounded-full border border-edge px-3 py-1 text-sm font-medium text-muted hover:bg-raise hover:text-ink"
        title="Login with Lithe"
      >
        Log in
      </button>
    );
  }

  const name = session.displayName || session.email || "Signed in";
  return (
    <button
      onClick={logout}
      className="group max-w-40 truncate rounded-full border border-edge px-3 py-1 text-sm font-medium text-ink hover:bg-raise"
      title={`Signed in via Lithe as ${name} — click to sign out`}
    >
      <span className="group-hover:hidden">{name}</span>
      <span className="hidden group-hover:inline">Sign out</span>
    </button>
  );
}
