import { createUrl } from './helpers';
import { isServerSide } from './server-side';

/**
 * Public, absolute URL of the API as seen from the user's browser.
 *
 * Server reads process.env directly. Client reads from the runtime
 * config injected into window.__KODUS_PUBLIC_CONFIG__ by the root
 * layout — same pattern as self-hosted.ts. Module-scope client
 * callers (e.g. ssoLogin in lib/auth/fetchers.ts) need a window-
 * backed getter because they can't call useConfig().
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
        ? process.env.WEB_HOSTNAME_API
            ? createUrl(
                  process.env.WEB_HOSTNAME_API,
                  process.env.WEB_PORT_API,
                  '',
              )
            : ''
        : ((globalThis as any).__KODUS_PUBLIC_CONFIG__?.apiPublicUrl ?? '');
    return raw.replace(/\/$/, '');
}
