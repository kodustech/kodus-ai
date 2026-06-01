/**
 * Build an absolute URL on the public API origin.
 *
 * Reads process.env.API_URL — the same env the frontend exposes as
 * apiPublicUrl, the same env passport-saml gets fed via the SAML
 * callback. Single source of truth so the URL the IdP receives, the
 * URL the user copies into their IdP config, and the URL the UI
 * redirects to during connection tests are byte-for-byte identical.
 *
 * Trims any trailing slash on the env value so callers can concatenate
 * `/some/path` without producing `http://host//some/path`. Throws when
 * the env is unset — that's an installation misconfiguration and we'd
 * rather fail loudly here than emit "undefined/..." into a SAMLRequest
 * or a Location header where the IdP / browser produces a confusing
 * error several layers later.
 */
export function buildApiUrl(path: string): string {
    const apiUrl = process.env.API_URL;
    if (!apiUrl) {
        throw new Error(
            'API_URL is not set. Set it to the public, browser-reachable ' +
                'URL of this API (e.g. https://api.example.com).',
        );
    }
    const base = apiUrl.replace(/\/$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${base}${suffix}`;
}
