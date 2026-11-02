/**
 * Where GitHub returns after the user authorizes the Kodus App to link an
 * installation (see core/integrations/github-installation-authorization).
 *
 * It sits under the App's sign-in callback URL so that no extra callback URL
 * has to be registered: GitHub accepts a subdirectory of a callback URL when
 * wildcard matching is on, the default for an App with one callback URL.
 * Only `code` and `state` are passed on to /github-integration.
 */
export function GET(request: Request) {
    const incoming = new URL(request.url).searchParams;
    const params = new URLSearchParams();
    for (const key of ["code", "state"]) {
        const value = incoming.get(key);
        if (value) params.set(key, value);
    }
    return new Response(null, {
        status: 302,
        headers: { Location: `/github-integration?${params.toString()}` },
    });
}
