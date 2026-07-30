import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
    invalidateRegisteredRepo,
    registerIntegration,
    registerRepo,
} from "../onboarding.js";
import { isGithubRateLimit } from "../runner.js";
import { GitHubProvider } from "../../providers/github.js";
import type { KodusSession, Provider, TargetContext } from "../types.js";
import { json, startMockServer } from "./mock-server.js";

// Minimal Provider stand-in for onboarding-layer tests: registerIntegration
// only touches integrationType/authMode/authToken/authExtraFields.
function fakeProvider(integrationType = "GITHUB"): Provider {
    return {
        name: integrationType.toLowerCase(),
        integrationType,
        authMode: () => "token",
        authToken: () => "fake-token",
    } as unknown as Provider;
}

function sessionFor(orgId: string): KodusSession {
    return {
        accessToken: "fake-jwt",
        organizationId: orgId,
        teamId: `team-${orgId}`,
    };
}

test("registerIntegration: caches per (api, org, platform) — one auth-integration POST per tenant per run", async () => {
    const server = await startMockServer([
        {
            method: "POST",
            pathRegex: /^\/code-management\/auth-integration$/,
            handler: (_req, res) => json(res, 200, { data: { status: "SUCCESS" } }),
        },
    ]);
    const target: TargetContext = {
        target: "self-hosted",
        apiBaseUrl: server.baseUrl,
        webBaseUrl: server.baseUrl,
        tunnelUrl: server.baseUrl,
    };
    try {
        const provider = fakeProvider();
        // Two scenarios on the SAME tenant → the second must reuse the
        // first registration instead of re-validating the token against
        // the provider (the Bitbucket-throttle trigger on run 28888685303).
        await registerIntegration(target, provider, sessionFor("org-cache-a"));
        await registerIntegration(target, provider, sessionFor("org-cache-a"));
        const posts = server.requests.filter(
            (r) => r.method === "POST" && r.path.startsWith("/code-management/auth-integration"),
        );
        assert.equal(posts.length, 1, "same tenant should register exactly once per run");

        // A DIFFERENT org (e.g. centralized-config-sync's throwaway tenant)
        // has its own cache slot and must still hit the real endpoint.
        await registerIntegration(target, provider, sessionFor("org-cache-b"));
        const postsAfter = server.requests.filter(
            (r) => r.method === "POST" && r.path.startsWith("/code-management/auth-integration"),
        );
        assert.equal(postsAfter.length, 2, "a different org must not reuse the cache");
    } finally {
        await server.close();
    }
});

test("registerIntegration: proxy 504 with server-side commit recovers via the connections probe", async () => {
    // qa.web.kodus.io's proxy read-times-out at 60s while the backend keeps
    // validating the token and commits the integration anyway. A 504
    // RESPONSE (not a client-side abort) must take the same recovery path.
    let landed = false;
    const server = await startMockServer([
        {
            method: "POST",
            pathRegex: /^\/code-management\/auth-integration$/,
            handler: (_req, res) => {
                landed = true; // backend committed despite the 504 we return
                json(res, 504, { message: "Gateway Timeout" });
            },
        },
        {
            method: "GET",
            pathRegex: /^\/integration\/connections/,
            handler: (_req, res) =>
                json(res, 200, {
                    data: landed
                        ? [{ platformName: "GITHUB", category: "CODE_MANAGEMENT" }]
                        : [],
                }),
        },
    ]);
    const target: TargetContext = {
        target: "self-hosted",
        apiBaseUrl: server.baseUrl,
        webBaseUrl: server.baseUrl,
        tunnelUrl: server.baseUrl,
    };
    try {
        // Must resolve (not throw) and cache the registration.
        await registerIntegration(target, fakeProvider(), sessionFor("org-proxy-504"));
        await registerIntegration(target, fakeProvider(), sessionFor("org-proxy-504"));
        const posts = server.requests.filter(
            (r) => r.method === "POST" && r.path.startsWith("/code-management/auth-integration"),
        );
        assert.equal(posts.length, 1, "recovered registration must be cached");
    } finally {
        await server.close();
    }
});

test("registerIntegration: platform A → B → A on one cloud org re-registers A (clearConflicting invalidates the cache)", async () => {
    // Cloud persistent-tenant shape: registering platform B DELETES A's
    // integration (clearConflictingIntegrations). A's cache entry must die
    // with it, or a later A cell would reuse the cache and leave the org
    // with no A integration at all.
    let active: string | null = null;
    const server = await startMockServer([
        {
            method: "GET",
            pathRegex: /^\/integration\/connections/,
            handler: (_req, res) =>
                json(res, 200, {
                    data: active
                        ? [{ platformName: active, category: "CODE_MANAGEMENT" }]
                        : [],
                }),
        },
        {
            method: "DELETE",
            pathRegex: /^\/code-management\/delete-integration/,
            handler: (_req, res) => {
                active = null;
                json(res, 200, {});
            },
        },
        {
            method: "POST",
            pathRegex: /^\/code-management\/auth-integration$/,
            handler: (_req, res, _match, body) => {
                active = (JSON.parse(body) as { integrationType: string })
                    .integrationType;
                json(res, 200, { data: { status: "SUCCESS" } });
            },
        },
    ]);
    const target: TargetContext = {
        target: "cloud",
        apiBaseUrl: server.baseUrl,
        webBaseUrl: server.baseUrl,
    };
    const session = sessionFor("org-a-b-a");
    const registrations = () =>
        server.requests.filter(
            (r) =>
                r.method === "POST" &&
                r.path === "/code-management/auth-integration",
        ).length;
    try {
        await registerIntegration(target, fakeProvider("GITHUB"), session);
        await registerIntegration(target, fakeProvider("GITHUB"), session);
        assert.equal(registrations(), 1, "same platform reuses the cache");
        assert.equal(active, "GITHUB");

        await registerIntegration(target, fakeProvider("GITLAB"), session);
        assert.equal(active, "GITLAB", "B replaced A");

        await registerIntegration(target, fakeProvider("GITHUB"), session);
        assert.equal(
            active,
            "GITHUB",
            "returning to A must re-register, not trust the stale cache",
        );
        assert.equal(registrations(), 3, "A, B, then A again — three real registrations");
    } finally {
        await server.close();
    }
});

test("invalidateRegisteredRepo: a deleted-and-recreated throwaway repo re-registers (webhook must be recreated)", async () => {
    const REPO = "kodus-e2e/tiny-url-trial-e2e-abc123";
    const server = await startMockServer([
        {
            method: "GET",
            pathRegex: /^\/code-management\/repositories\/org/,
            handler: (_req, res) =>
                json(res, 200, {
                    data: [{ id: 1, full_name: REPO, name: "tiny-url-trial-e2e-abc123" }],
                }),
        },
        {
            method: "POST",
            pathRegex: /^\/code-management\/repositories$/,
            handler: (_req, res) => json(res, 200, { data: { status: true } }),
        },
    ]);
    const target: TargetContext = {
        target: "self-hosted",
        apiBaseUrl: server.baseUrl,
        webBaseUrl: server.baseUrl,
        tunnelUrl: server.baseUrl,
    };
    const provider = {
        ...fakeProvider(),
        repoRef: async () => ({ id: 1, name: "tiny-url-trial-e2e-abc123", full_name: REPO }),
    } as unknown as Provider;
    const session = sessionFor("org-repo-invalidate");
    const posts = () =>
        server.requests.filter(
            (r) => r.method === "POST" && r.path === "/code-management/repositories",
        ).length;
    try {
        await registerRepo(target, provider, session);
        await registerRepo(target, provider, session);
        assert.equal(posts(), 1, "second call must reuse the cache");
        // Scenario retry path: throwaway repo deleted + recreated under the
        // same name — the cache entry must die with the repo, otherwise the
        // recreated repo never gets its webhook (nightly 28926099375).
        invalidateRegisteredRepo(REPO);
        await registerRepo(target, provider, session);
        assert.equal(posts(), 2, "post-invalidation call must re-register");
    } finally {
        await server.close();
    }
});

test("pollForReview: GitHub rate-limit envelope surfaces as an explicit rate-limit error (not 'items is not iterable')", async () => {
    // GitHub answers list endpoints with an error ENVELOPE (an object,
    // not an array) when the per-account quota is exhausted. Before the
    // listOrThrow guard, filterNonTrigger iterated that object and the
    // scenario FAILED with an opaque "items is not iterable" the runner
    // couldn't classify — gating release run 28888685303 red. It must
    // instead throw a message isGithubRateLimit() recognizes, so the
    // runner marks the cell as a loud non-gating SKIP.
    const ghServer = await startMockServer([
        {
            method: "GET",
            pathRegex: /^\/repos\/[^/]+\/[^/]+\/(pulls|issues)\/\d+\/(comments|reviews)/,
            handler: (_req, res) =>
                json(res, 403, {
                    message:
                        "API rate limit exceeded for user ID 12345. If you reach out to GitHub Support...",
                    documentation_url:
                        "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
                }),
        },
    ]);
    // Restore only the mutated keys — reassigning process.env wholesale
    // replaces Node's env proxy with a plain object.
    const savedEnv = new Map(
        ["GH_TEST_TOKEN", "GH_TEST_REPO"].map((k) => [k, process.env[k]]),
    );
    const originalFetch = global.fetch;
    process.env.GH_TEST_TOKEN = "fake";
    process.env.GH_TEST_REPO = "kodustech/qa-fixture";
    // The provider hardcodes api.github.com — redirect to the mock.
    global.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        return originalFetch(
            url.replace("https://api.github.com", ghServer.baseUrl),
            init,
        );
    };
    try {
        const provider = new GitHubProvider({ target: "self-hosted" });
        await assert.rejects(
            provider.pollForReview(
                { number: 42 },
                { sinceIso: new Date(0).toISOString(), timeoutSec: 5 },
            ),
            (err: Error) => {
                assert.match(err.message, /rate limit exceeded/i);
                assert.ok(
                    isGithubRateLimit(err.message),
                    `runner must classify as rate limit, got: ${err.message}`,
                );
                return true;
            },
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
