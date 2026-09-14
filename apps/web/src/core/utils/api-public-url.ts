import { isServerSide } from './server-side';

/**
 * Public, absolute URL of the API as seen from the user's browser.
 *
 * Server reads process.env.API_URL directly — the same env
 * libs/ee/sso/utils/api-url.util.ts uses for the SAML callback origin,
 * so the URL the IdP receives and the URL the browser is sent to are
 * byte-for-byte identical. This must NOT be WEB_HOSTNAME_API: that var
 * is the in-cluster/in-network address the web server uses for its
 * own server-side /api/proxy/* calls, and is not reachable from the
 * user's browser (see values.yaml in the self-hosted chart).
 *
 * Client reads from the runtime config injected into
 * window.__KODUS_PUBLIC_CONFIG__ by the root layout — same pattern as
 * self-hosted.ts. Module-scope client callers (e.g. ssoLogin in
 * lib/auth/fetchers.ts) need a window-backed getter because they
 * can't call useConfig().
 *
 * Returns "" when not configured. Callers MUST handle the empty case
 * (typically: refuse to start the flow with a clear error) rather
 * than building a broken URL with an empty origin.
 *
 * Always strip a trailing slash so callers can concatenate paths
 * without thinking about it.
 */
export function getApiPublicUrl(): string {
    const raw = isServerSide
        ? (process.env.API_URL ?? '')
        : ((globalThis as any).__KODUS_PUBLIC_CONFIG__?.apiPublicUrl ?? '');
    return raw.replace(/\/$/, '');
}
