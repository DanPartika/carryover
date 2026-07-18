"use client";

// Hard login gate: when Lithe is configured, anonymous visitors see only the login
// screen. This is UX-level — every API route separately verifies the JWT server-side
// (the gateway is public; platform ref §3). /callback must stay reachable so the OIDC
// code exchange can complete for a not-yet-signed-in user. Without Lithe config
// (standalone dev) there is no gate.

import { usePathname } from "next/navigation";
import { useAuth } from "./AuthContext";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { enabled, loading, session, login } = useAuth();
  const pathname = usePathname();

  if (!enabled || pathname === "/callback" || session) return <>{children}</>;
  if (loading) return null;

  return (
    <div className="mx-auto max-w-md flex-1 px-4 py-20 text-center">
      <div className="text-4xl" aria-hidden>
        ↪
      </div>
      <h1 className="mt-3 text-2xl font-extrabold">
        <span className="brand-text">Carryover</span>
      </h1>
      <p className="mt-3 text-sm text-muted">
        Your PT&apos;s plan, always with you — see your home exercises, log how
        they went, and let your progress carry back to your next visit. Sign in
        with your Lithe account to continue.
      </p>
      <button
        onClick={login}
        className="mt-6 rounded-full bg-accent-deep px-5 py-2 font-semibold text-white transition hover:brightness-110"
      >
        Login with Lithe
      </button>
    </div>
  );
}
