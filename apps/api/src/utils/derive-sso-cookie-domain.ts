/**
 * Derives the `Domain` attribute for the SSO handoff cookie.
 *
 * Cookie must be a parent of BOTH the API host (which emits Set-Cookie)
 * and the frontend host (which reads it on /sso-callback). Hard-coding
 * a value works for SaaS but breaks every self-hosted deployment.
 *
 * Strategy: smallest common DNS suffix between API and frontend hosts,
 * with a `>= 2 labels` guard so we never produce ".io" / ".com" /
 * ".co.uk" cookies (which would either leak or be silently rejected
 * by the public-suffix list).
 *
 * Returns `undefined` for:
 *   - development env (no Domain → host-only cookie on the API host)
 *   - hosts without a common parent (operator must align topology)
 *   - malformed URLs
 *
 * Examples:
 *   apiHost=api.kodus.io,            frontendHost=app.kodus.io           → ".kodus.io"
 *   apiHost=kodus-api-dev.web.scorpion.co, frontendHost=kodus-dev.web.scorpion.co → ".web.scorpion.co"
 *   apiHost=kodus.io,                frontendHost=kodus.io               → ".kodus.io"
 *   apiHost=192.168.1.10,            frontendHost=192.168.1.10           → undefined (numeric)
 *   apiHost=kodus.co.uk,             frontendHost=another.co.uk          → undefined (only ".co.uk" common)
 *   apiHost=api.foo.com,             frontendHost=app.bar.com            → undefined (no common parent)
 */
export function deriveSsoCookieDomain(params: {
    apiHost: string;
    frontendUrl: string;
    nodeEnv?: string;
}): string | undefined {
    const { apiHost, frontendUrl, nodeEnv } = params;

    if (nodeEnv === 'development') {
        return undefined;
    }

    let frontendHost: string;
    try {
        frontendHost = new URL(frontendUrl).hostname;
    } catch {
        return undefined;
    }

    if (!apiHost || !frontendHost) {
        return undefined;
    }

    // IPv4 / IPv6 literals can never be cookie Domains per RFC 6265 §5.1.3.
    if (/^[\d.]+$/.test(apiHost) || /^[\d.]+$/.test(frontendHost)) {
        return undefined;
    }
    if (apiHost.includes(':') || frontendHost.includes(':')) {
        return undefined;
    }

    const a = apiHost.toLowerCase().split('.').reverse();
    const b = frontendHost.toLowerCase().split('.').reverse();
    const common: string[] = [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) break;
        common.push(a[i]);
    }

    if (common.length < 2) {
        return undefined;
    }

    return '.' + common.reverse().join('.');
}
