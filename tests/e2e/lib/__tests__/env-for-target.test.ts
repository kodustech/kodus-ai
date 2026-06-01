import { strict as assert } from "node:assert";
import { test } from "node:test";
import { selfhostedEnvSuffix } from "../runner.js";
import type { ProviderName } from "../types.js";

// The per-provider parallel matrix points each provider's cells at its own
// droplet via SELFHOSTED_API_BASE_URL_<SUFFIX>. The suffix must be stable
// and shell-safe (uppercase, non-alnum collapsed to `_`) so the bash side
// (--auto-provision-per-provider) and the runner agree on the var name.
test("selfhostedEnvSuffix derives stable, shell-safe per-provider tokens", () => {
    const cases: Array<[ProviderName, string]> = [
        ["github", "GITHUB"],
        ["gitlab", "GITLAB"],
        ["bitbucket", "BITBUCKET"],
        ["azure-devops", "AZURE_DEVOPS"],
        ["github-app", "GITHUB_APP"],
    ];
    for (const [provider, expected] of cases) {
        assert.equal(selfhostedEnvSuffix(provider), expected);
    }
});
