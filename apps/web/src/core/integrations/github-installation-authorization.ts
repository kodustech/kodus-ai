import { SETUP_PATHS } from "@services/setup";
import { axiosAuthorized } from "src/core/utils/axios";

/**
 * Linking a GitHub App installation needs GitHub's word that the user can see
 * it: the API issues GitHub's authorization page with a state bound to the
 * user, GitHub sends the user back with a code (through
 * /api/auth/callback/github/installation to `/github-integration`), and the
 * page that started the link gets the code and state as `github_code` and
 * `github_state`.
 */

const STORAGE_KEY = "kodus.github-installation-authorization";

export const GITHUB_CODE_PARAM = "github_code";
export const GITHUB_STATE_PARAM = "github_state";

type Pending = { state: string; returnTo: string };

/** Sends the user to GitHub's authorization page for this installation. */
export async function startGithubInstallationAuthorization(
    installationId: string,
    returnTo: string,
): Promise<void> {
    const response = await axiosAuthorized.fetcher<
        { url: string } | { data: { url: string } }
    >(SETUP_PATHS.GITHUB_INSTALLATION_AUTHORIZATION, {
        params: { installationId },
    });
    const url = "url" in response ? response.url : response.data.url;
    const state = new URL(url).searchParams.get("state") ?? "";
    try {
        sessionStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ state, returnTo } satisfies Pending),
        );
    } catch {
        // Without storage the user comes back to /github-integration itself.
    }
    window.location.href = url;
}

/** The installation id a state was issued for (the state is signed by the API). */
/**
 * Whether the setup page for `integration` still has to send the user to
 * GitHub's authorization before it can link `installationId`: a GitHub
 * installation without the code and state that authorization returns.
 */
export function needsGithubInstallationAuthorization(params: {
    integration: string | null | undefined;
    installationId: string | null;
    githubCode: string | null;
    githubState: string | null;
}): boolean {
    return (
        params.integration === "github" &&
        !!params.installationId &&
        (!params.githubCode || !params.githubState)
    );
}

export function installationIdFromState(state: string): string | null {
    try {
        const payload = JSON.parse(
            atob(state.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")),
        ) as { installationId?: unknown };
        return typeof payload.installationId === "string"
            ? payload.installationId
            : null;
    } catch {
        return null;
    }
}

/**
 * Where to continue after GitHub's authorization: the page that started it,
 * with the code and state added. Only a same-origin path is followed.
 */
export function githubAuthorizationReturnPath(
    code: string,
    state: string,
): string {
    let returnTo: string | null = null;
    try {
        const pending = JSON.parse(
            sessionStorage.getItem(STORAGE_KEY) ?? "null",
        ) as Pending | null;
        sessionStorage.removeItem(STORAGE_KEY);
        if (pending?.state === state && pending.returnTo.startsWith("/")) {
            returnTo = pending.returnTo;
        }
    } catch {
        returnTo = null;
    }

    const url = new URL(
        returnTo && !returnTo.startsWith("//")
            ? returnTo
            : `/github-integration?installation_id=${installationIdFromState(state) ?? ""}`,
        window.location.origin,
    );
    url.searchParams.set(GITHUB_CODE_PARAM, code);
    url.searchParams.set(GITHUB_STATE_PARAM, state);
    return url.pathname + url.search;
}
