import type { Provider, ProviderName, Target } from "../lib/types.js";
import { AzureDevOpsProvider } from "./azure-devops.js";
import { BitbucketProvider } from "./bitbucket.js";
import { GitHubProvider } from "./github.js";
import { GitHubAppProvider } from "./github-app.js";
import { GitLabProvider } from "./gitlab.js";

// `target` selects the per-target fixture repo (cloud vs self-hosted) so the
// two targets hit independent repos and can run concurrently without colliding.
// Defaults to self-hosted, which falls back to the original `*_TEST_REPO`.
export function makeProvider(
    name: ProviderName,
    target: Target = "self-hosted",
): Provider {
    switch (name) {
        case "github":
            return new GitHubProvider({ target });
        case "github-app":
            // App variant is cloud-only and pinned to its own App-bound repo
            // (GH_APP_TEST_REPO), so it's already repo-independent.
            return new GitHubAppProvider();
        case "gitlab":
            return new GitLabProvider(target);
        case "bitbucket":
            return new BitbucketProvider(target);
        case "azure-devops":
            return new AzureDevOpsProvider(target);
        default: {
            const exhaustive: never = name;
            throw new Error(`Unknown provider: ${exhaustive}`);
        }
    }
}

export {
    AzureDevOpsProvider,
    BitbucketProvider,
    GitHubAppProvider,
    GitHubProvider,
    GitLabProvider,
};
