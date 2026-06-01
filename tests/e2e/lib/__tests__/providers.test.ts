import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeProvider } from "../../providers/index.js";
import type { ProviderName } from "../types.js";

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
        saved[k] = process.env[k];
        process.env[k] = env[k];
    }
    try {
        return fn();
    } finally {
        for (const k of Object.keys(env)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

test("makeProvider github constructs with required env", () => {
    withEnv(
        {
            GH_TEST_TOKEN: "test-token",
            GH_TEST_REPO: "owner/repo",
        },
        () => {
            const p = makeProvider("github");
            assert.equal(p.name, "github");
            assert.equal(p.integrationType, "GITHUB");
            assert.equal(p.webhookPath, "/github/webhook");
            assert.equal(p.authMode(), "token");
            assert.equal(p.authToken(), "test-token");
            assert.equal(p.licenseGitTool(), "github");
        },
    );
});

test("makeProvider gitlab constructs with required env", () => {
    withEnv(
        {
            GL_TEST_TOKEN: "gl-token",
            GL_TEST_REPO: "group/project",
        },
        () => {
            const p = makeProvider("gitlab");
            assert.equal(p.name, "gitlab");
            assert.equal(p.integrationType, "GITLAB");
            assert.equal(p.webhookPath, "/gitlab/webhook");
            assert.equal(p.authMode(), "token");
            assert.equal(p.authToken(), "gl-token");
            assert.equal(p.licenseGitTool(), "gitlab");
        },
    );
});

test("makeProvider bitbucket constructs with required env", () => {
    withEnv(
        {
            BB_TEST_USER: "bbuser",
            BB_TEST_APP_PASSWORD: "bbpass",
            BB_TEST_REPO: "workspace/slug",
        },
        () => {
            const p = makeProvider("bitbucket");
            assert.equal(p.name, "bitbucket");
            assert.equal(p.integrationType, "BITBUCKET");
            assert.equal(p.webhookPath, "/bitbucket/webhook");
            // BitbucketProvider routes app-password auth through Kodus's
            // AuthMode.TOKEN branch (the backend doesn't know "app-password"
            // as a mode; sending it bypasses authenticateWithToken entirely).
            assert.equal(p.authMode(), "token");
            assert.equal(p.authToken(), "bbpass");
            assert.equal(p.licenseGitTool(), "bitbucket");
        },
    );
});

test("makeProvider azure-devops constructs with required env", () => {
    withEnv(
        {
            AZ_TEST_TOKEN: "az-pat",
            AZ_TEST_ORG: "kodusorg",
            AZ_TEST_PROJECT: "kodusproj",
            AZ_TEST_REPO: "kodus-fixture",
        },
        () => {
            const p = makeProvider("azure-devops");
            assert.equal(p.name, "azure-devops");
            assert.equal(p.integrationType, "AZURE_REPOS");
            assert.equal(p.webhookPath, "/azure-repos/webhook");
            assert.equal(p.authMode(), "token");
            assert.equal(p.authToken(), "az-pat");
            // Kodus lowercases the platformType "AZURE_REPOS" for gitTool.
            assert.equal(p.licenseGitTool(), "azure_repos");
        },
    );
});

test("makeProvider throws on missing required env", () => {
    const originalToken = process.env.GH_TEST_TOKEN;
    const originalRepo = process.env.GH_TEST_REPO;
    delete process.env.GH_TEST_TOKEN;
    delete process.env.GH_TEST_REPO;
    try {
        assert.throws(() => makeProvider("github"), /GH_TEST_TOKEN/);
    } finally {
        if (originalToken) process.env.GH_TEST_TOKEN = originalToken;
        if (originalRepo) process.env.GH_TEST_REPO = originalRepo;
    }
});

test("makeProvider throws on unknown provider name", () => {
    assert.throws(
        () => makeProvider("forgejo" as ProviderName),
        /Unknown provider/,
    );
});

test("all 4 platform providers have distinct webhook paths", () => {
    // github-app is intentionally not in this set — it shares the
    // /github/webhook path with github (same platform, different
    // auth mode). The uniqueness invariant is per-platform, not
    // per-provider.
    withEnv(
        {
            GH_TEST_TOKEN: "t", GH_TEST_REPO: "o/r",
            GL_TEST_TOKEN: "t", GL_TEST_REPO: "g/p",
            BB_TEST_USER: "u", BB_TEST_APP_PASSWORD: "p", BB_TEST_REPO: "w/s",
            AZ_TEST_TOKEN: "t", AZ_TEST_ORG: "o", AZ_TEST_PROJECT: "p", AZ_TEST_REPO: "r",
        },
        () => {
            const paths = new Set([
                makeProvider("github").webhookPath,
                makeProvider("gitlab").webhookPath,
                makeProvider("bitbucket").webhookPath,
                makeProvider("azure-devops").webhookPath,
            ]);
            assert.equal(paths.size, 4, "webhook paths must be unique");
        },
    );
});

test("makeProvider github-app constructs and uses oauth + installation_id", () => {
    withEnv(
        {
            GH_TEST_TOKEN: "gh-pat",
            GH_APP_TEST_REPO: "kodus-e2e/tiny-url-app",
            GH_APP_INSTALLATION_ID: "134164671",
        },
        () => {
            const p = makeProvider("github-app");
            assert.equal(p.name, "github-app");
            assert.equal(p.integrationType, "GITHUB");
            assert.equal(p.webhookPath, "/github/webhook");
            assert.equal(p.authMode(), "oauth");
            assert.equal(
                p.authToken(),
                "134164671",
                "authToken returns the installation id — the backend reads it as `code` for the oauth flow",
            );
        },
    );
});
