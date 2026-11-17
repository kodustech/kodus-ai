import {
    GITHUB_RETURN_COOKIE,
    GITHUB_RETURN_MAX_AGE_S,
    safeReturnPath,
} from "src/core/integrations/github-installation-authorization";
import { ClientSideCookieHelpers } from "src/core/utils/cookie";

import { getGithubInstallationAuthorizationUrl } from "./fetch";

/**
 * Sends the user to GitHub's authorization page for `installationId`; GitHub
 * comes back through /api/auth/callback/github/installation to `returnTo`.
 */
export async function startGithubInstallationAuthorization(
    installationId: string,
    returnTo: string,
    navigate: (url: string) => void = (url) => {
        window.location.href = url;
    },
): Promise<void> {
    const path = safeReturnPath(returnTo);
    if (!path) throw new Error(`Not a path of this site: ${returnTo}`);

    const url = await getGithubInstallationAuthorizationUrl(installationId);
    ClientSideCookieHelpers(GITHUB_RETURN_COOKIE, {
        path: "/",
        maxAge: GITHUB_RETURN_MAX_AGE_S,
        sameSite: "lax",
    }).set(path);
    navigate(url);
}
