/**
 * Build the client-side path that hits the API proxy route
 * (`/api/proxy/api/[...path]/route.ts`). Same-origin, so cookies ride
 * along automatically; the Next server resolves the internal hostname
 * and forwards the request.
 *
 * Safe to import from client components — unlike `pathToApiUrl`, this
 * function does not read any env vars.
 */
export function apiProxyPath(path: string): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `/api/proxy/api${normalized}`;
}
