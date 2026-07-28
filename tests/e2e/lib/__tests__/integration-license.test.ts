import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMatrix } from "../runner.js";
import { resolveScenarios } from "../../scenarios/index.js";
import {
    json,
    kodusRoutes,
    startMockServer,
    type RouteHandler,
} from "./mock-server.js";

const TEST_PR_NUMBER = 77;
const TEST_REPO = "kodustech/qa-fixture";
const ORG_ID = "org-license-test";
const TEAM_ID = "team-license-test";

interface RunOpts {
    license: "paid" | "license-paid" | "free" | "license-free" | "trial";
    target: "cloud" | "self-hosted";
    /** If true, the mock returns a Kody response; if false, it stays silent. */
    kodyResponds: boolean;
}

async function runLicenseScenario(opts: RunOpts): Promise<{
    status: string;
    errorMessage?: string;
    evidence: Record<string, unknown>;
}> {
    const reviewWindow = { triggeredAt: "" };

    const ghRoutes: RouteHandler[] = [
        {
            // closeOpenPRsBetween preflight — pretend no leftovers.
            method: "GET",
            pathRegex: /^\/repos\/[^/]+\/[^/]+\/pulls\?/,
            handler: (_req, res) => json(res, 200, []),
        },
        {
            // openPRFromBranches → new PR. Stash the creation time so the
            // polling routes below can return a Kody response that lands
            // AFTER the PR was opened (mirrors `since=` filter semantics).
            method: "POST",
            pathRegex: /^\/repos\/[^/]+\/[^/]+\/pulls$/,
            handler: (_req, res) => {
                reviewWindow.triggeredAt = new Date().toISOString();
                json(res, 201, {
                    number: TEST_PR_NUMBER,
                    html_url: `https://github.com/${TEST_REPO}/pull/${TEST_PR_NUMBER}`,
                });
            },
        },
        {
            // closePR (PATCH /pulls/{number}) — always succeeds.
            method: "PATCH",
            pathRegex: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/,
            handler: (_req, res) => json(res, 200, {}),
        },
        // openPRFromBranches now opens each PR from a UNIQUE throwaway
        // branch (empty commit on the fixture tip) to dodge GitHub's
        // 100-PRs-per-head_sha cap. That adds a git dance the mock must
        // answer; the branch name carries a slash (feature/add-stats), so
        // the ref/heads patterns use `.+` not `[^/]+`.
        {
            // resolveHead: GET git/ref/heads/{branch} → { object: { sha } }
            method: "GET",
            pathRegex: /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/.+$/,
            handler: (_req, res) =>
                json(res, 200, { object: { sha: "fixturetip0000000000000000000000000000000" } }),
        },
        {
            // resolveTree: GET git/commits/{sha} → { tree: { sha } }
            method: "GET",
            pathRegex: /^\/repos\/[^/]+\/[^/]+\/git\/commits\/[^/]+$/,
            handler: (_req, res) =>
                json(res, 200, { tree: { sha: "fixturetree000000000000000000000000000000" } }),
        },
        {
            // create empty commit: POST git/commits → { sha }
            method: "POST",
            pathRegex: /^\/repos\/[^/]+\/[^/]+\/git\/commits$/,
            handler: (_req, res) =>
                json(res, 201, { sha: "throwaway00000000000000000000000000000000" }),
        },
        {
            // create throwaway branch ref: POST git/refs
            method: "POST",
            pathRegex: /^\/repos\/[^/]+\/[^/]+\/git\/refs$/,
            handler: (_req, res) => json(res, 201, {}),
        },
        {
            // closePR cleanup: DELETE git/refs/heads/{branch}
            method: "DELETE",
            pathRegex: /^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/.+$/,
            handler: (_req, res) => json(res, 204, {}),
        },
        {
            method: "GET",
            pathRegex: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments/,
            handler: (_req, res) => {
                if (!opts.kodyResponds) {
                    json(res, 200, []);
                    return;
                }
                const responseTime = new Date(
                    new Date(reviewWindow.triggeredAt).getTime() + 1000,
                ).toISOString();
                // Inline review comment from Kody — counts as
                // `reviewComments`. We can't return only an issueComment
                // because the scenario's "expectReview" branch accepts any
                // bucket and the "expectNoReview" branch wants zero in any
                // bucket; both paths are exercised by varying kodyResponds.
                json(res, 200, [
                    {
                        id: 3003,
                        body: "Kody mock: 1 issue.",
                        created_at: responseTime,
                    },
                ]);
            },
        },
        {
            method: "GET",
            pathRegex: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments/,
            handler: (_req, res) => {
                // When the tenant is on a license-blocked tier and Kody
                // is otherwise silent on review comments, the production
                // behavior is for Kody to post a "Your trial has ended"
                // notification as a top-level issue comment carrying the
                // `<!-- kody-codereview -->` marker. The scenario layer
                // detects that pattern via `licenseBlockedNotice` and
                // treats it as the expected blocked-state signal. Without
                // this, the mock can't reproduce the cloud blocked-tier
                // path that the scenario now asserts on.
                const blockedTier =
                    opts.license === "free" || opts.license === "license-free";
                if (!opts.kodyResponds && blockedTier) {
                    const responseTime = new Date(
                        new Date(reviewWindow.triggeredAt).getTime() + 500,
                    ).toISOString();
                    json(res, 200, [
                        {
                            id: 4004,
                            body:
                                "## Your trial has ended! 😢\n\n" +
                                "To keep getting reviews, activate your plan [here](https://app.kodus.io/settings/subscription) or configure your BYOK key.\n\n" +
                                "<!-- kody-codereview -->",
                            created_at: responseTime,
                        },
                    ]);
                    return;
                }
                json(res, 200, []);
            },
        },
        {
            method: "GET",
            pathRegex: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews/,
            handler: (_req, res) => json(res, 200, []),
        },
        {
            method: "GET",
            pathRegex: /^\/repos\/[^/]+\/[^/]+(?:\?|$)/,
            handler: (_req, res) =>
                json(res, 200, { id: 9999, full_name: TEST_REPO, name: "qa-fixture" }),
        },
    ];

    const kodusServer = await startMockServer(
        kodusRoutes({
            orgId: ORG_ID,
            teamId: TEAM_ID,
            repoId: 9999,
            repoFullName: TEST_REPO,
            repoName: "qa-fixture",
        }),
    );
    const ghServer = await startMockServer(ghRoutes);
    const artifactRoot = mkdtempSync(join(tmpdir(), "e2e-lic-"));
    const originalEnv = { ...process.env };
    const originalFetch = global.fetch;

    try {
        // Both target-scoped envs and legacy generic envs so the test
        // works against either branch of envForTarget. The runner now
        // prefers SELFHOSTED_*/CLOUD_* (target-scoped) over the legacy
        // TARGET_* (which cross-pollinated cloud cells with the
        // self-hosted droplet URL in matrix runs — see 2026-05-20 fix).
        process.env.TARGET_BASE_URL = kodusServer.baseUrl;
        process.env.TARGET_WEB_URL = kodusServer.baseUrl;
        process.env.TARGET_TUNNEL_URL = "https://dummy.trycloudflare.com";
        process.env.SELFHOSTED_API_BASE_URL = kodusServer.baseUrl;
        process.env.SELFHOSTED_WEB_URL = kodusServer.baseUrl;
        process.env.SELFHOSTED_TUNNEL_URL = "https://dummy.trycloudflare.com";
        process.env.CLOUD_API_BASE_URL = kodusServer.baseUrl;
        process.env.CLOUD_WEB_BASE_URL = kodusServer.baseUrl;
        if (opts.target === "self-hosted") {
            process.env.SH_TENANT_EMAIL = "test@kodus.test";
            process.env.SH_TENANT_PASSWORD = "secret";
        } else {
            const map = {
                free: "CLOUD_TENANT_FREE",
                trial: "CLOUD_TENANT_TRIAL",
                paid: "CLOUD_TENANT_PAID",
            } as const;
            const prefix = map[opts.license as keyof typeof map];
            if (prefix) {
                process.env[`${prefix}_EMAIL`] = `${opts.license}@kodus.test`;
                process.env[`${prefix}_PASSWORD`] = "secret";
            }
        }
        process.env.GH_TEST_TOKEN = "fake-token";
        process.env.GH_TEST_REPO = TEST_REPO;
        process.env.GH_TEST_PR_NUMBER = String(TEST_PR_NUMBER);

        // Speed up polls so the test doesn't block for the scenario's
        // production timeout. These envs are read by pollUntil.
        process.env.E2E_POLL_INTERVAL_OVERRIDE_SEC = "0.05";
        process.env.E2E_POLL_TIMEOUT_OVERRIDE_SEC = "3";
        // The polls were already collapsed; the runner's absence-retry SETTLE
        // was not, so the "review never arrives" case slept a real 120s before
        // its retry — 146s for that one test.
        process.env.E2E_SETTLE_OVERRIDE_SEC = "0";

        global.fetch = async (input, init) => {
            const url = typeof input === "string" ? input : input.toString();
            return originalFetch(
                url.replace("https://api.github.com", ghServer.baseUrl),
                init,
            );
        };

        const outcome = await runMatrix({
            artifactRoot,
            runId: `license-${opts.license}-${opts.kodyResponds}`,
            target: opts.target,
            cells: [
                { target: opts.target, provider: "github", license: opts.license },
            ],
            scenarios: resolveScenarios(["license-attribution"]),
        });

        const result = outcome.results[0];
        return {
            status: result?.status ?? "no-result",
            errorMessage: result?.errorMessage,
            evidence: (result?.evidence ?? {}) as Record<string, unknown>,
        };
    } finally {
        global.fetch = originalFetch;
        process.env = originalEnv;
        await kodusServer.close();
        await ghServer.close();
        rmSync(artifactRoot, { recursive: true, force: true });
    }
}

test("integration license: self-hosted license-paid expects review and gets it → passes", async () => {
    const r = await runLicenseScenario({
        target: "self-hosted",
        license: "license-paid",
        kodyResponds: true,
    });
    assert.equal(r.status, "passed", `expected passed, got ${r.status}: ${r.errorMessage}`);
    assert.equal((r.evidence as { expectReview?: boolean }).expectReview, true);
    assert.equal(
        (r.evidence as { sawRealReview?: boolean }).sawRealReview,
        true,
    );
});

test("integration license: self-hosted license-paid expects review but none arrives → fails", async () => {
    const r = await runLicenseScenario({
        target: "self-hosted",
        license: "license-paid",
        kodyResponds: false,
    });
    assert.equal(r.status, "failed", `expected failed, got ${r.status}`);
    assert.ok(
        r.errorMessage?.includes("Expected a real review for license=license-paid"),
        `error should mention paid-but-no-review; got: ${r.errorMessage}`,
    );
});

// Blocked-tier mechanic (no real review + a "trial ended / BYOK" notice)
// is validated on CLOUD `free` — the only tier+target where Kody actually
// emits that notice. It used to be tested on self-hosted `license-free`,
// but that combination was removed from license-attribution.appliesTo:
// on self-hosted, an invalid/absent license drops to Community Edition
// (reviews fire, no notice) — SelfHostedLicenseService never produces the
// BYOK/trial notice, so the assertion was structurally unprovable there.
test("integration license: cloud free expects no review and gets license-block notice → passes", async () => {
    const r = await runLicenseScenario({
        target: "cloud",
        license: "free",
        kodyResponds: false,
    });
    assert.equal(r.status, "passed", `expected passed, got ${r.status}: ${r.errorMessage}`);
    assert.equal((r.evidence as { expectReview?: boolean }).expectReview, false);
    assert.equal(
        (r.evidence as { sawRealReview?: boolean }).sawRealReview,
        false,
    );
    assert.equal(
        (r.evidence as { sawLicenseNotice?: boolean }).sawLicenseNotice,
        true,
        "blocked tier should surface a licenseBlockedNotice",
    );
});

test("integration license: cloud free expects no review but Kody answers → fails (entitlement leak)", async () => {
    const r = await runLicenseScenario({
        target: "cloud",
        license: "free",
        kodyResponds: true,
    });
    assert.equal(
        r.status,
        "failed",
        `expected failed (free leaked review), got ${r.status}`,
    );
    assert.ok(
        r.errorMessage?.includes("Expected NO real review for license=free"),
        `error should mention free-with-review; got: ${r.errorMessage}`,
    );
});

test("integration license: cloud paid expects review and gets it → passes", async () => {
    const r = await runLicenseScenario({
        target: "cloud",
        license: "paid",
        kodyResponds: true,
    });
    assert.equal(r.status, "passed", `expected passed, got ${r.status}: ${r.errorMessage}`);
});
