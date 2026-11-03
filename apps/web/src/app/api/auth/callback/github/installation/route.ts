import { NextResponse, type NextRequest } from "next/server";
import {
    GITHUB_CODE_PARAM,
    GITHUB_ERROR_PARAM,
    GITHUB_RETURN_COOKIE,
    GITHUB_STATE_PARAM,
    safeReturnPath,
} from "src/core/integrations/github-installation-authorization";

/** Only to parse the return path; the redirect keeps path and query. */
const BASE = "http://return.invalid";

/**
 * Where GitHub returns after the user authorizes the Kodus App to link an
 * installation (see core/integrations/github-installation-authorization).
 *
 * It sits under the App's sign-in callback URL so that no extra callback URL
 * has to be registered: GitHub accepts a subdirectory of a callback URL when
 * wildcard matching is on, the default for an App with one callback URL.
 *
 * The page that started the authorization left its path in a cookie; the user
 * goes straight back there with GitHub's code and state, or with an error.
 * The redirect is relative, so it never leaves this site.
 */
export function GET(request: NextRequest) {
    const incoming = request.nextUrl.searchParams;
    const target = returnTarget(
        safeReturnPath(request.cookies.get(GITHUB_RETURN_COOKIE)?.value),
    );

    const code = incoming.get("code");
    const state = incoming.get("state");
    if (!target) {
        // No way back to the page that started it (another browser, or the
        // cookie expired). The onboarding's setup page explains it and goes
        // back to the Git tool step; otherwise the GitHub page says it.
        const fromOnboarding = request.cookies.has(
            "started-setup-from-new-setup-page",
        );
        return redirect(
            fromOnboarding
                ? `/setup/github?${GITHUB_ERROR_PARAM}=expired`
                : `/github-integration?${GITHUB_ERROR_PARAM}=expired`,
        );
    }
    if (code && state) {
        target.searchParams.set(GITHUB_CODE_PARAM, code);
        target.searchParams.set(GITHUB_STATE_PARAM, state);
    } else {
        target.searchParams.set(
            GITHUB_ERROR_PARAM,
            incoming.get("error") ?? "missing_code",
        );
    }
    return redirect(`${target.pathname}${target.search}`);
}

/** The return path parsed, or null when normalizing it leaves this site ("/.//host"). */
function returnTarget(path: string | null): URL | null {
    if (!path) return null;
    const url = new URL(path, BASE);
    if (url.origin !== BASE || url.pathname.startsWith("//")) return null;
    return url;
}

function redirect(location: string): NextResponse {
    const response = new NextResponse(null, {
        status: 302,
        headers: { Location: location },
    });
    response.cookies.delete({ name: GITHUB_RETURN_COOKIE, path: "/" });
    return response;
}
