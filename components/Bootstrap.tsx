"use client";

// One bootstrap call per page load, shared. The nav needs roles to know which
// links a patient should never see, and the home page needs the same payload
// for its setup guide — fetching twice would double bootstrap's writes
// (last_login_at, the JIT users upsert) and let the two readers disagree
// mid-flight.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { useAuth } from "@/components/AuthContext";

export type Membership = { clinicId: string; clinicName: string; role: string };

export type Bootstrap = {
  user: {
    id: string;
    litheUserId: string;
    email: string;
    displayName: string;
    isAppAdmin: boolean;
  };
  memberships: Membership[];
};

type BootstrapState = {
  boot: Bootstrap | null;
  error: string | null;
  /** True while auth or the first fetch is still settling. */
  pending: boolean;
  /** Any clinician-side standing anywhere: pt or admin in a clinic, or app admin. */
  isStaff: boolean;
  /** Re-fetch — for flows that change membership (clinic creation). */
  refresh: () => void;
};

const Ctx = createContext<BootstrapState | null>(null);

export function BootstrapProvider({ children }: { children: React.ReactNode }) {
  const { enabled, loading, session } = useAuth();
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (loading) return;
    if (enabled && !session) {
      // Logged out: RequireAuth is showing the login screen; there is no
      // bootstrap to fetch and nothing role-gated to render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPending(false);
      setBoot(null);
      return;
    }
    let alive = true;
    apiFetch("/api/bootstrap", { method: "POST" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`bootstrap ${res.status}`);
        return (await res.json()) as Bootstrap;
      })
      .then((b) => {
        if (!alive) return;
        setBoot(b);
        setError(null);
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setPending(false));
    return () => {
      alive = false;
    };
  }, [enabled, loading, session, reloadKey]);

  const refresh = useCallback(() => setReloadKey((n) => n + 1), []);
  const isStaff =
    !!boot &&
    (boot.user.isAppAdmin || boot.memberships.some((m) => m.role === "pt" || m.role === "admin"));

  const value = useMemo<BootstrapState>(
    () => ({ boot, error, pending, isStaff, refresh }),
    [boot, error, pending, isStaff, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBootstrap(): BootstrapState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useBootstrap must be used within BootstrapProvider");
  return ctx;
}
