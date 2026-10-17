// The app's base path under Lithe's gateway (e.g. "/apps/clientfirst"), "" when
// running at the root. Next auto-prefixes <Link>/router/assets, but literal URLs
// (metadata icons, client-side fetch() to our own API, OIDC redirect URIs) need
// it explicitly.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}

/** Where we are now, with the base path stripped, so it survives a round-trip
 *  through Zitadel and can be handed straight back to withBase(). */
export function currentRelativePath(): string {
  const { pathname, search } = window.location;
  const rest =
    BASE_PATH && pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) : pathname;
  return (rest || "/") + search;
}

/** A path is only safe to redirect to if it stays on this origin — "//evil.com"
 *  is a protocol-relative URL, not a path. */
export function safeRelativePath(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}
