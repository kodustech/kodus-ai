import type { ProviderName } from "../lib/types.js";
import { requireEnv } from "./base.js";
import { GitHubProvider } from "./github.js";

// GitHub App (OAuth installation) variant of the GitHubProvider.
//
// Why a separate class instead of an env switch inside github.ts:
//   - lets the matrix run BOTH github (PAT) and github-app (App) in the
//     same run, on different cells, exercising different code paths
//     in github.service.ts (authenticateWithToken vs authenticateWithCodeOauth);
//   - keeps the matrix filter pruning trivial (no scenario has to know
//     "github means PAT, env GH_APP_INSTALLATION_ID overrides to App");
//   - matches how the backend models it — authMode is per-integration,
//     not per-instance.
//
// Required env (set in scripts/e2e/.env or ~/.kodus-dev/config):
//   GH_APP_TEST_REPO          full_name of the repo the App is installed in
//                             (e.g. kodus-e2e/tiny-url-app)
//   GH_APP_INSTALLATION_ID    numeric installation id captured after the
//                             one-time install on github.com
//   GH_TEST_TOKEN             still required — used for opening PRs,
//                             posting comments, listing webhooks, etc.
//                             from a *user* viewpoint. The App's
//                             installation token is short-lived and
//                             can't easily drive a deterministic PR-open
//                             flow from outside the integration. Reusing
//                             the user PAT here keeps the E2E surface
//                             identical to github (PAT) for everything
//                             except the auth-integration step.
//
// Backend prerequisites (cloud only): API_GITHUB_APP_ID,
// API_GITHUB_APP_PRIVATE_KEY, GLOBAL_GITHUB_CLIENT_ID, API_GITHUB_CLIENT_SECRET.
// QA cloud already has these; self-hosted droplets typically don't, which
// is why this provider's cells are cloud-only.
export class GitHubAppProvider extends GitHubProvider {
    readonly name: ProviderName = "github-app";

    private readonly installationId: string;

    constructor() {
        // Redirect the whole surface (clone URL, /repos/* calls,
        // webhook listing) to the App-bound repo via the parent's
        // repoOverride hook.
        super({ repoOverride: requireEnv("GH_APP_TEST_REPO") });
        this.installationId = requireEnv("GH_APP_INSTALLATION_ID");
    }

    override authMode(): "token" | "oauth" | "app-password" {
        return "oauth";
    }

    // For the OAuth path the value flows into the `code` field of the
    // auth-integration request body (see lib/onboarding.ts). We keep
    // the name `authToken` to satisfy the Provider interface; semantics
    // are "the credential the backend uses to identify this auth flow".
    override authToken(): string {
        return this.installationId;
    }
}

export default GitHubAppProvider;
