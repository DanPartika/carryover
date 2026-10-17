// Browser-side fetch wrapper for our own /api routes: attaches the Lithe access
// token (the same raw JWT the server then forwards to /v1/me and /v1/ai) and
// prefixes the gateway base path, which client-side fetch() doesn't get for free.

import { getAuthProvider } from "@/lib/auth/provider";
import { withBase } from "@/lib/config/basePath";

/** Fired on `window` when any request is refused because the episode it
 *  targeted has been closed — a page holding a stale view listens, reloads, and
 *  says so, rather than every button reporting its own bare "(409)". */
export const EPISODE_CLOSED_EVENT = "carryover:episode-closed";

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const session = await getAuthProvider().session();
  const headers = new Headers(init.headers);
  if (session) headers.set("Authorization", `Bearer ${session.accessToken}`);
  const res = await fetch(withBase(path), { ...init, headers });

  if (res.status === 409 && typeof window !== "undefined") {
    try {
      const body = (await res.clone().json()) as { code?: string } | null;
      if (body?.code === "episode_closed") window.dispatchEvent(new Event(EPISODE_CLOSED_EVENT));
    } catch {
      // Not JSON — nothing to announce.
    }
  }
  return res;
}
