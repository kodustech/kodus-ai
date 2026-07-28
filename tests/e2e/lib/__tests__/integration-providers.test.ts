import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { runMatrix } from "../runner.js";
import { resolveScenarios } from "../../scenarios/index.js";
import {
    json,
    kodusRoutes,
    startMockServer,
    type ReviewWindow,
    type RouteHandler,
} from "./mock-server.js";
import type { MatrixCell } from "../types.js";

const ORG_ID = "org-uuid-789";
const TEAM_ID = "team-uuid-789";

/**
 * Runs a single self-hosted × <provider> × license-paid scenario against a
 * fully mocked Kodus + provider HTTP surface. Returns the runner outcome so
 * each provider-specific test can assert on it.
 *
 * Each provider integration test is essentially identical structurally — the
 * provider routes differ but the Kodus side, env var setup, fetch
 * redirection, and runner invocation are the same. The differences live
 * inside `providerRoutes` and `fetchRedirect`.
 */
async function runScenarioAgainstMocks(opts: {
    cell: MatrixCell;
    providerEnv: Record<string, string>;
    providerRoutes: RouteHandler[];
    fetchRedirect: (originalUrl: string, providerBase: string) => string;
}): Promise<{
    status: string;
    errorMessage?: string;
    evidence: Record<string, unknown>;
    kodusRequests: Array<{ method: string; path: string }>;
    providerRequests: Array<{ method: string; path: string }>;
}> {
    const kodusServer = await startMockServer(
        kodusRoutes({
            orgId: ORG_ID,
            teamId: TEAM_ID,
            repoId: 8888,
            repoFullName: opts.providerEnv.REPO_FULL_NAME ?? "kodus/fixture",
            repoName: "fixture",
        }),
    );
    const providerServer = await startMockServer(opts.providerRoutes);

    const artifactRoot = mkdtempSync(join(tmpdir(), "e2e-int-"));
    const originalEnv = { ...process.env };
    const originalFetch = global.fetch;

    try {
        process.env.TARGET_BASE_URL = kodusServer.baseUrl;
        process.env.TARGET_WEB_URL = kodusServer.baseUrl;
        process.env.TARGET_TUNNEL_URL = "https://dummy.trycloudflare.com";
        process.env.SH_TENANT_EMAIL = "test@kodus.test";
        process.env.SH_TENANT_PASSWORD = "secret123";
        // Collapse the production waits — the mocks answer instantly, so every
        // second spent here is dead time. Without these this file alone ran
        // 13min (three providers × a 120s persistence poll + a 120s retry
        // settle each) against a 5min job budget, and CI killed the job before
        // Bitbucket and Azure ever reported. Same knobs the sibling
        // integration tests already use; production sets none of them.
        process.env.E2E_POLL_INTERVAL_OVERRIDE_SEC = "0.05";
        process.env.E2E_POLL_TIMEOUT_OVERRIDE_SEC = "3";
        process.env.E2E_SETTLE_OVERRIDE_SEC = "0";
        for (const [k, v] of Object.entries(opts.providerEnv)) {
            process.env[k] = v;
        }

        global.fetch = async (input, init) => {
            const url = typeof input === "string" ? input : input.toString();
            return originalFetch(opts.fetchRedirect(url, providerServer.baseUrl), init);
        };

        const outcome = await runMatrix({
            artifactRoot,
            runId: `int-${opts.cell.provider}`,
            target: opts.cell.target,
            cells: [opts.cell],
            scenarios: resolveScenarios(["code-review-basic"]),
        });

        const result = outcome.results[0];
        return {
            status: result?.status ?? "no-result",
            errorMessage: result?.errorMessage,
            evidence: (result?.evidence ?? {}) as Record<string, unknown>,
            kodusRequests: kodusServer.requests.map((r) => ({
                method: r.method,
                path: r.path,
            })),
            providerRequests: providerServer.requests.map((r) => ({
                method: r.method,
                path: r.path,
            })),
        };
    } finally {
        global.fetch = originalFetch;
        process.env = originalEnv;
        await kodusServer.close();
        await providerServer.close();
        rmSync(artifactRoot, { recursive: true, force: true });
    }
}

// ---------- GitLab ----------

test("integration: GitLab — runner drives MR review through provider abstraction", async () => {
    const reviewWindow: ReviewWindow = { triggeredAt: "" };
    const PROJECT_PATH = "kodusqa/fixture";
    const MR_IID = 7;

    const result = await runScenarioAgainstMocks({
        cell: { target: "self-hosted", provider: "gitlab", license: "license-paid" },
        providerEnv: {
            GL_TEST_TOKEN: "gl-test",
            GL_TEST_REPO: PROJECT_PATH,
            GL_TEST_MR_IID: String(MR_IID),
            GL_HOST: "https://gitlab.com",
            REPO_FULL_NAME: PROJECT_PATH,
        },
        providerRoutes: [
            {
                method: "GET",
                pathRegex: /^\/api\/v4\/projects\/[^/]+$/,
                handler: (_req, res) =>
                    json(res, 200, { id: 12345 }),
            },
            {
                // openPRFromBranches now creates a UNIQUE throwaway branch
                // first (POST repository/branches?branch=&ref=) before the
                // MR, to dodge per-head limits — mock it as success.
                method: "POST",
                pathRegex: /^\/api\/v4\/projects\/\d+\/repository\/branches(?:\?|$)/,
                handler: (_req, res) => json(res, 201, { name: "e2e/throwaway" }),
            },
            {
                // openPRFromBranches → creates a new MR
                method: "POST",
                pathRegex: /^\/api\/v4\/projects\/\d+\/merge_requests$/,
                handler: (_req, res: ServerResponse) => {
                    reviewWindow.triggeredAt = new Date().toISOString();
                    json(res, 201, {
                        iid: MR_IID,
                        web_url: `https://gitlab.com/${PROJECT_PATH}/-/merge_requests/${MR_IID}`,
                    });
                },
            },
            {
                // closePR
                method: "PUT",
                pathRegex: /^\/api\/v4\/projects\/\d+\/merge_requests\/\d+$/,
                handler: (_req, res) => json(res, 200, { state: "closed" }),
            },
            {
                // closePR cleanup: DELETE the throwaway branch
                method: "DELETE",
                pathRegex: /^\/api\/v4\/projects\/\d+\/repository\/branches\/.+$/,
                handler: (_req, res) => json(res, 204, {}),
            },
            {
                method: "POST",
                pathRegex: /^\/api\/v4\/projects\/\d+\/merge_requests\/\d+\/notes$/,
                handler: (_req, res: ServerResponse) => {
                    const created = new Date().toISOString();
                    json(res, 201, {
                        id: 5555,
                        body: "@kody review",
                        created_at: created,
                        author: { id: 1, username: "kodus-bot" },
                        system: false,
                    });
                },
            },
            {
                method: "GET",
                pathRegex: /^\/api\/v4\/projects\/\d+\/merge_requests\/\d+\/notes/,
                handler: (_req, res) => {
                    const responseTime = new Date(
                        new Date(reviewWindow.triggeredAt).getTime() + 1500,
                    ).toISOString();
                    json(res, 200, [
                        {
                            id: 5556,
                            body: "Kody (mock) found 1 issue in this MR.",
                            created_at: responseTime,
                            author: { id: 1, username: "kodus-bot" },
                            system: false,
                        },
                    ]);
                },
            },
        ],
        fetchRedirect: (url, base) =>
            url.replace("https://gitlab.com/api/v4", `${base}/api/v4`),
    });

    assert.equal(result.status, "passed", `GitLab failed: ${result.errorMessage}`);
    const evidence = result.evidence as { prNumber?: number };
    assert.equal(evidence.prNumber, MR_IID);
    assert.ok(
        result.providerRequests.some(
            (r) =>
                r.method === "POST" &&
                r.path.match(/^\/api\/v4\/projects\/\d+\/merge_requests$/),
        ),
        "GitLab openPRFromBranches (POST /merge_requests) was not called",
    );
    assert.ok(
        result.providerRequests.some(
            (r) => r.method === "GET" && r.path.includes("/merge_requests/"),
        ),
        "GitLab MR notes were not polled",
    );
});

// ---------- Bitbucket ----------

test("integration: Bitbucket — runner drives PR review through provider abstraction", async () => {
    const reviewWindow: ReviewWindow = { triggeredAt: "" };
    const WORKSPACE_SLUG = "kodusqa/fixture";
    const PR_ID = 11;

    const result = await runScenarioAgainstMocks({
        cell: { target: "self-hosted", provider: "bitbucket", license: "license-paid" },
        providerEnv: {
            BB_TEST_USER: "kodus-bot",
            BB_TEST_APP_PASSWORD: "secret-app-pw",
            BB_TEST_REPO: WORKSPACE_SLUG,
            BB_TEST_PR_ID: String(PR_ID),
            REPO_FULL_NAME: WORKSPACE_SLUG,
        },
        providerRoutes: [
            {
                method: "GET",
                pathRegex: /^\/repositories\/[^/]+\/[^/]+(?:\?|$)/,
                handler: (_req, res) =>
                    json(res, 200, {
                        uuid: "{repo-uuid-1}",
                        full_name: WORKSPACE_SLUG,
                        name: "fixture",
                    }),
            },
            {
                // openPRFromBranches step 1 — GET fixture branch ref
                // (the new throwaway-branch flow reads its target.hash
                // to use as the seed commit for the throwaway).
                method: "GET",
                pathRegex: /^\/repositories\/[^/]+\/[^/]+\/refs\/branches\/.+$/,
                handler: (_req, res) =>
                    json(res, 200, {
                        name: "fixture/test",
                        target: { hash: "deadbeefcafebabe1234" },
                    }),
            },
            {
                // openPRFromBranches step 2 — POST throwaway branch
                // pointing at the fixture's tip commit. Bitbucket
                // returns 201 with the created ref.
                method: "POST",
                pathRegex: /^\/repositories\/[^/]+\/[^/]+\/refs\/branches$/,
                handler: (_req, res) =>
                    json(res, 201, {
                        name: "e2e/throwaway",
                        target: { hash: "deadbeefcafebabe1234" },
                    }),
            },
            {
                // openPRFromBranches step 3 — POST /pullrequests.
                // The freshness check on the provider now reads
                // `state` and `created_on` from this body, so the
                // mock must include both — without them the
                // ageMs computation in the provider would mark
                // the response as suspicious and throw.
                method: "POST",
                pathRegex: /^\/repositories\/[^/]+\/[^/]+\/pullrequests$/,
                handler: (_req, res) => {
                    reviewWindow.triggeredAt = new Date().toISOString();
                    json(res, 201, {
                        id: PR_ID,
                        state: "OPEN",
                        created_on: reviewWindow.triggeredAt,
                        links: {
                            html: {
                                href: `https://bitbucket.org/${WORKSPACE_SLUG}/pull-requests/${PR_ID}`,
                            },
                        },
                    });
                },
            },
            {
                // closePR step 1 — decline PR.
                method: "POST",
                pathRegex: /^\/repositories\/[^/]+\/[^/]+\/pullrequests\/\d+\/decline$/,
                handler: (_req, res) => json(res, 200, { state: "DECLINED" }),
            },
            {
                // closePR step 2 — delete throwaway branch. Required
                // since the new openPRFromBranches sets
                // keepBranchOnClose: false.
                method: "DELETE",
                pathRegex: /^\/repositories\/[^/]+\/[^/]+\/refs\/branches\/.+$/,
                handler: (_req, res) => json(res, 204, {}),
            },
            {
                method: "POST",
                pathRegex: /^\/repositories\/[^/]+\/[^/]+\/pullrequests\/\d+\/comments$/,
                handler: (_req, res) => {
                    const created = new Date().toISOString();
                    json(res, 201, {
                        id: 4001,
                        content: { raw: "@kody review" },
                        created_on: created,
                        user: { uuid: "{user}", display_name: "kodus-bot" },
                    });
                },
            },
            {
                method: "GET",
                pathRegex: /^\/repositories\/[^/]+\/[^/]+\/pullrequests\/\d+\/comments/,
                handler: (_req, res) => {
                    const responseTime = new Date(
                        new Date(reviewWindow.triggeredAt).getTime() + 1500,
                    ).toISOString();
                    json(res, 200, {
                        values: [
                            {
                                id: 4002,
                                content: { raw: "Kody (mock) flagged 2 issues." },
                                created_on: responseTime,
                                user: { uuid: "{user}", display_name: "kodus-bot" },
                            },
                        ],
                    });
                },
            },
        ],
        fetchRedirect: (url, base) =>
            url.replace("https://api.bitbucket.org/2.0", base),
    });

    assert.equal(
        result.status,
        "passed",
        `Bitbucket failed: ${result.errorMessage}`,
    );
    const evidence = result.evidence as { prNumber?: number };
    assert.equal(evidence.prNumber, PR_ID);
    assert.ok(
        result.providerRequests.some(
            (r) =>
                r.method === "POST" &&
                r.path.match(/^\/repositories\/[^/]+\/[^/]+\/pullrequests$/),
        ),
        "Bitbucket openPRFromBranches (POST /pullrequests) was not called",
    );
});

// ---------- Azure DevOps ----------

test("integration: Azure DevOps — runner drives PR review through provider abstraction", async () => {
    const reviewWindow: ReviewWindow = { triggeredAt: "" };
    const ORG = "kodus-org";
    const PROJECT = "kodus-project";
    const REPO = "fixture-repo";
    const PR_ID = 23;
    const REPO_GUID = "az-repo-uuid-1";

    const result = await runScenarioAgainstMocks({
        cell: {
            target: "self-hosted",
            provider: "azure-devops",
            license: "license-paid",
        },
        providerEnv: {
            AZ_TEST_TOKEN: "az-pat",
            AZ_TEST_ORG: ORG,
            AZ_TEST_PROJECT: PROJECT,
            AZ_TEST_REPO: REPO,
            AZ_TEST_PR_ID: String(PR_ID),
            REPO_FULL_NAME: `${ORG}/${PROJECT}/${REPO}`,
        },
        providerRoutes: [
            {
                // openPRFromBranches/closePR resolveHead: GET refs?filter=heads/{branch}
                // → { value: [{ objectId }] }. Must precede the repo catch-all
                // below (which only matches the bare repository id).
                method: "GET",
                pathRegex: /^\/[^/]+\/[^/]+\/_apis\/git\/repositories\/[^/]+\/refs(?:\?|$)/,
                handler: (_req, res) =>
                    json(res, 200, { value: [{ objectId: "azfixturetip000000000000000000000000000000" }] }),
            },
            {
                // createBranch (and closePR branch delete) both POST to refs.
                method: "POST",
                pathRegex: /^\/[^/]+\/[^/]+\/_apis\/git\/repositories\/[^/]+\/refs(?:\?|$)/,
                handler: (_req, res) =>
                    json(res, 200, { value: [{ success: true }] }),
            },
            {
                method: "GET",
                pathRegex: /^\/[^/]+\/[^/]+\/_apis\/git\/repositories\/[^/?]+(?:\?|$)/,
                handler: (_req, res) => json(res, 200, { id: REPO_GUID }),
            },
            {
                // openPRFromBranches → creates a new PR
                method: "POST",
                pathRegex: /^\/[^/]+\/[^/]+\/_apis\/git\/repositories\/[^/]+\/pullrequests/,
                handler: (_req, res) => {
                    reviewWindow.triggeredAt = new Date().toISOString();
                    json(res, 201, {
                        pullRequestId: PR_ID,
                        _links: {
                            web: {
                                href: `https://dev.azure.com/${ORG}/${PROJECT}/_git/${REPO}/pullrequest/${PR_ID}`,
                            },
                        },
                    });
                },
            },
            {
                // closePR (PATCH abandon). Same path as above but PATCH method.
                method: "PATCH",
                pathRegex: /^\/[^/]+\/[^/]+\/_apis\/git\/repositories\/[^/]+\/pullrequests\/\d+/,
                handler: (_req, res) => json(res, 200, { status: "abandoned" }),
            },
            {
                method: "POST",
                pathRegex: /^\/[^/]+\/[^/]+\/_apis\/git\/repositories\/[^/]+\/pullRequests\/\d+\/threads/,
                handler: (_req, res) => {
                    const created = new Date().toISOString();
                    reviewWindow.triggeredAt = created;
                    json(res, 200, {
                        id: 7001,
                        publishedDate: created,
                        comments: [
                            {
                                id: 9001,
                                content: "@kody review",
                                publishedDate: created,
                            },
                        ],
                    });
                },
            },
            {
                method: "GET",
                pathRegex: /^\/[^/]+\/[^/]+\/_apis\/git\/repositories\/[^/]+\/pullRequests\/\d+\/threads/,
                handler: (_req, res) => {
                    const responseTime = new Date(
                        new Date(reviewWindow.triggeredAt).getTime() + 1500,
                    ).toISOString();
                    json(res, 200, {
                        value: [
                            {
                                id: 7001,
                                publishedDate: responseTime,
                                comments: [
                                    {
                                        id: 9001,
                                        content: "@kody review",
                                        publishedDate: reviewWindow.triggeredAt,
                                    },
                                    {
                                        id: 9002,
                                        content:
                                            "Kody (mock) found 3 issues in this PR.",
                                        publishedDate: responseTime,
                                    },
                                ],
                            },
                        ],
                    });
                },
            },
        ],
        fetchRedirect: (url, base) =>
            url.replace("https://dev.azure.com", base),
    });

    assert.equal(
        result.status,
        "passed",
        `Azure DevOps failed: ${result.errorMessage}`,
    );
    const evidence = result.evidence as { prNumber?: number };
    assert.equal(evidence.prNumber, PR_ID);
    assert.ok(
        result.providerRequests.some(
            (r) =>
                r.method === "POST" &&
                /\/_apis\/git\/repositories\/[^/]+\/pullrequests(?:\?|$)/.test(
                    r.path,
                ),
        ),
        "Azure DevOps openPRFromBranches (POST /pullrequests) was not called",
    );
    assert.ok(
        result.providerRequests.some(
            (r) =>
                r.method === "GET" &&
                r.path.includes("/pullRequests/") &&
                r.path.includes("/threads"),
        ),
        "Azure DevOps threads were not polled",
    );
});
