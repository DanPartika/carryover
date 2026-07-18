// Browser-side fetch wrapper for our own /api routes: attaches the Lithe access
// token (the same raw JWT the server then forwards to /v1/me and /v1/ai) and
// prefixes the gateway base path, which client-side fetch() doesn't get for free.

import { getAuthProvider } from "@/lib/auth/provider";
import { withBase } from "@/lib/config/basePath";

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const session = await getAuthProvider().session();
  const headers = new Headers(init.headers);
  if (session) headers.set("Authorization", `Bearer ${session.accessToken}`);
  return fetch(withBase(path), { ...init, headers });
}
