// The app's base path under Lithe's gateway (e.g. "/apps/clientfirst"), "" when
// running at the root. Next auto-prefixes <Link>/router/assets, but literal URLs
// (metadata icons, client-side fetch() to our own API, OIDC redirect URIs) need
// it explicitly.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}
