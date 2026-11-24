import { INTEGRATIONS_KEY } from "@enums";

/**
 * Linking a GitHub App installation needs GitHub's word that the user can see
 * it. The page that links asks the API for GitHub's authorization page (with
 * a state the API seals), keeps where to come back in a short-lived cookie,
 * and GitHub returns to /api/auth/callback/github/installation. That route
 * sends the user back to the page with `github_code` and `github_state`, or
 * `github_error` when GitHub refused or the cookie is gone.
 *
 * Shared by the client pages and the route handler: nothing here runs only
 * in the browser.
 */

export const GITHUB_CODE_PARAM = "github_code";
export const GITHUB_STATE_PARAM = "github_state";
export const GITHUB_ERROR_PARAM = "github_error";

export const GITHUB_RETURN_COOKIE = "github-installation-return-to";
/** As long as the API's state lives. */
export const GITHUB_RETURN_MAX_AGE_S = 10 * 60;

/** A path of this site, never another origin (`//host`, `/\host`). */
export function safeReturnPath(value: string | null | undefined): string | null {
    if (!value || !value.startsWith("/")) return null;
    if (value.startsWith("//") || value.startsWith("/\\")) return null;
    return value;
}

/**
 * Whether the setup page for `integration` still has to send the user to
 * GitHub's authorization before it can link `installationId`.
 */
export function needsGithubInstallationAuthorization(params: {
    integration: string | null | undefined;
    installationId: string | null;
    githubCode: string | null;
    githubState: string | null;
    githubError: string | null;
}): boolean {
    return (
        params.integration === INTEGRATIONS_KEY.GITHUB &&
        !!params.installationId &&
        !params.githubError &&
        (!params.githubCode || !params.githubState)
    );
}

/** What to tell the user when GitHub's authorization did not come back. */
export function githubAuthorizationErrorMessage(error: string): string {
    switch (error) {
        case "access_denied":
            return "The GitHub authorization was cancelled. Connect GitHub again when you are ready.";
        case "expired":
            return "The GitHub authorization took too long or was started in another browser. Start the GitHub connection again.";
        default:
            return "GitHub did not complete the authorization. Start the GitHub connection again.";
    }
}
