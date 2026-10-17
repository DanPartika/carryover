"use client";

// OIDC redirect target for "Login with Lithe" (must match the redirect URI
// registered for Carryover in Lithe's app registry:
// <origin>/apps/carryover/callback).

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getAuthProvider } from "@/lib/auth/provider";
import { withBase } from "@/lib/config/basePath";

export default function CallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // React StrictMode (on by default in Next dev) runs effects twice; the code
  // exchange consumes the one-time PKCE state, so the second run would throw
  // "No matching state found" even though login succeeded. Run exactly once.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const auth = getAuthProvider();
    if (!auth.enabled) {
      router.replace("/");
      return;
    }
    auth
      .completeLogin()
      .then(({ returnTo }) => {
        // Both outcomes land here: a real sign-in, and a prompt=none bounce that
        // found no SSO session — that one just arrives back signed out, and the
        // page it returns to shows the sign-in screen.
        // Full navigation (not router.replace) so AuthContext re-reads the session.
        // window.location doesn't know the base path, so prefix it explicitly.
        window.location.replace(withBase(returnTo));
      })
      .catch((err) => setError((err as Error).message));
  }, [router]);

  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      {error ? (
        <>
          <p className="font-semibold text-flag">Login failed</p>
          <p className="mt-2 text-sm text-muted">{error}</p>
        </>
      ) : (
        <p className="text-muted">Signing you in…</p>
      )}
    </div>
  );
}
