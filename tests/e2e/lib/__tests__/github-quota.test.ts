import { strict as assert } from "node:assert";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import {
    githubAppConfigured,
    githubAppToken,
    resetGithubAppTokenCache,
} from "../github-app-token.js";
import { GitHubProvider } from "../../providers/github.js";
import { json, startMockServer } from "./mock-server.js";

test("conditionalGet: polls send If-None-Match and 304s serve the cached body (free of rate-limit cost)", async () => {
    let calls = 0;
    const seen: Array<string | undefined> = [];
    const ghServer = await startMockServer([
        {
            method: "GET",
            pathRegex: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments/,
            handler: (req, res) => {
                calls++;
                seen.push(req.headers["if-none-match"] as string | undefined);
                if (req.headers["if-none-match"] === '"etag-1"') {
                    res.writeHead(304).end();
                    return;
                }
                res.setHeader("etag", '"etag-1"');
                json(res, 200, []);
            },
        },
    ]);
    // Restore ONLY the keys this test mutates — reassigning process.env
    // wholesale would swap Node's env proxy for a plain object and stop
    // writes from propagating to child processes.
    const MUTATED = [
        "GH_TEST_TOKEN",
        "GH_TEST_REPO",
        "E2E_POLL_INTERVAL_OVERRIDE_SEC",
        "E2E_POLL_TIMEOUT_OVERRIDE_SEC",
    ] as const;
    const savedEnv = new Map(MUTATED.map((k) => [k, process.env[k]]));
    const originalFetch = global.fetch;
    process.env.GH_TEST_TOKEN = "fake";
    process.env.GH_TEST_REPO = "kodustech/qa-fixture";
    // Fast poll so three iterations fit in the window.
    process.env.E2E_POLL_INTERVAL_OVERRIDE_SEC = "0.1";
    process.env.E2E_POLL_TIMEOUT_OVERRIDE_SEC = "0.5";
    global.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        return originalFetch(
            url.replace("https://api.github.com", ghServer.baseUrl),
            init,
        );
    };
    try {
        const provider = new GitHubProvider({ target: "self-hosted" });
        // No kody comment ever arrives → poll runs to timeout and throws.
        await assert.rejects(
            provider.waitForPipelineStart(
                { number: 7 },
                { sinceIso: new Date(0).toISOString(), timeoutSec: 0.5 },
            ),
            /No kody-codereview status comment/,
        );
        assert.ok(calls >= 2, `expected ≥2 polls, got ${calls}`);
        assert.equal(seen[0], undefined, "first poll must be unconditional");
        assert.ok(
            seen.slice(1).every((h) => h === '"etag-1"'),
            `subsequent polls must carry If-None-Match: ${JSON.stringify(seen)}`,
        );
    } finally {
        global.fetch = originalFetch;
        for (const [k, v] of savedEnv) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        await ghServer.close();
    }
});

test("authToken: the integration credential stays the durable PAT even when the harness runs on an App token", async () => {
    // The runner may hand the provider a ~1h GitHub App installation token
    // for harness-side quota. That token must NEVER become the credential
    // Kodus stores on the integration — the product would be left with an
    // expired secret mid-run.
    const saved = process.env.GH_TEST_TOKEN;
    process.env.GH_TEST_TOKEN = "ghp_durable_pat";
    process.env.GH_TEST_REPO = "kodustech/qa-fixture";
    try {
        const provider = new GitHubProvider({
            target: "self-hosted",
            tokenOverride: "ghs_expiring_app_token",
        });
        assert.equal(provider.authToken(), "ghp_durable_pat");
        // Without the durable PAT, an App-token provider must fail loudly
        // rather than hand the backend a ~1h credential.
        delete process.env.GH_TEST_TOKEN;
        assert.throws(
            () => provider.authToken(),
            /GH_TEST_TOKEN.*required/,
            "App token without durable PAT must throw, not be stored",
        );
        // A misconfigured GH_TEST_TOKEN holding an installation token must
        // also be rejected — no ghs_ in the durable slot, ever.
        process.env.GH_TEST_TOKEN = "ghs_misconfigured_secret";
        assert.throws(
            () => provider.authToken(),
            /ghs_.*durable PAT/,
            "ghs_ GH_TEST_TOKEN must throw, not be stored",
        );
    } finally {
        if (saved === undefined) delete process.env.GH_TEST_TOKEN;
        else process.env.GH_TEST_TOKEN = saved;
    }
});

test("githubAppToken: mints an installation token via App JWT and caches it until near expiry", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
    });
    let mints = 0;
    let sawBearerJwt = false;
    const server = await startMockServer([
        {
            method: "POST",
            pathRegex: /^\/app\/installations\/(777|888)\/access_tokens$/,
            handler: (req, res) => {
                mints++;
                const auth = String(req.headers.authorization ?? "");
                // App JWT = three dot-separated base64url segments.
                sawBearerJwt = /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(auth);
                json(res, 201, {
                    token: `ghs_installation_${mints}`,
                    expires_at: new Date(Date.now() + 3600_000).toISOString(),
                });
            },
        },
    ]);
    const env = {
        GH_APP_ID: "123",
        GH_APP_PRIVATE_KEY: privateKey as string,
        GH_APP_INSTALLATION_ID: "777",
    } as NodeJS.ProcessEnv;
    resetGithubAppTokenCache();
    try {
        assert.equal(githubAppConfigured(env), true);
        assert.equal(githubAppConfigured({} as NodeJS.ProcessEnv), false);
        assert.equal(
            await githubAppToken({} as NodeJS.ProcessEnv, server.baseUrl),
            undefined,
            "unconfigured must be a silent no-op (PAT pool takes over)",
        );

        const t1 = await githubAppToken(env, server.baseUrl);
        assert.equal(t1, "ghs_installation_1");
        assert.ok(sawBearerJwt, "mint call must authenticate with an App JWT");
        const t2 = await githubAppToken(env, server.baseUrl);
        assert.equal(t2, "ghs_installation_1", "fresh token must be reused");
        assert.equal(mints, 1, "second call must not re-mint");

        // A DIFFERENT identity must not receive the cached token (cache is
        // keyed by apiBase + app + installation).
        const otherEnv = { ...env, GH_APP_INSTALLATION_ID: "888" };
        const tOther = await githubAppToken(otherEnv, server.baseUrl);
        assert.equal(
            tOther,
            "ghs_installation_2",
            "different installation must mint its own token",
        );

        resetGithubAppTokenCache();
        const t3 = await githubAppToken(env, server.baseUrl);
        assert.equal(t3, "ghs_installation_3", "post-expiry call re-mints");
    } finally {
        resetGithubAppTokenCache();
        await server.close();
    }
});
