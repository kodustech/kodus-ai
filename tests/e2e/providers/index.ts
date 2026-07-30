import type { Provider, ProviderName, Target } from "../lib/types.js";
import { AzureDevOpsProvider } from "./azure-devops.js";
import { BitbucketProvider } from "./bitbucket.js";
import { GitHubProvider } from "./github.js";
import { GitHubAppProvider } from "./github-app.js";
import { GitLabProvider } from "./gitlab.js";

// `target` selects the per-target fixture repo (cloud vs self-hosted) so the
// two targets hit independent repos and can run concurrently without colliding.
// Defaults to self-hosted, which falls back to the original `*_TEST_REPO`.
//
// `repoOverride` pins THIS provider to a specific `owner/name` repo,
// taking precedence over the env-resolved per-target default. Used to
// give each cloud GitHub PAT tenant its own repo (1 org : 1 repo), so a
// shared repo never fans a webhook out across multiple orgs. Only the
// GitHub PAT provider honours it; the others are already 1 org : 1 repo
// on cloud and ignore it, and github-app is pinned to its App-bound repo.
// `githubToken` overrides the GitHub PAT for this provider instance — the
// matrix runner round-robins it across the bot-account pool so no single
// account's rate limit caps the whole run (see lib/github-token-pool.ts).
// Ignored by the non-GitHub providers and by github-app (installation auth).
export function makeProvider(
    name: ProviderName,
    target: Target = "self-hosted",
    repoOverride?: string,
    githubToken?: string,
): Provider {
    switch (name) {
        case "github":
            return new GitHubProvider({
                target,
                repoOverride,
                tokenOverride: githubToken,
            });
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
