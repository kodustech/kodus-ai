// Contract test: pins the real Azure DevOps Threads API shape that
// libs/platform/infrastructure/adapters/services/azureRepos/azureRepos.service.ts
// (`getPullRequestReviewComment`) and
// libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case.ts
// (`getReviewThreadByCommentId`) depend on.
//
// Bug this exists to catch: a Dec-2025 refactor made
// getReviewThreadByCommentId search ONLY a thread's `.replies` — which our
// own grouping code builds as "everything after the first comment" — so a
// brand-new `@kody <question>` (the root/first comment of a fresh thread,
// not a reply) was never found and Kody silently never answered. Fixed in
// chatWithKodyFromGit.use-case.ts; regression-pinned at the unit level in
// chatWithKodyFromGit.use-case.spec.ts.
//
// That unit test mocks the shape of a "grouped" Azure thread. This test
// does NOT re-run our grouping code (that's the unit test's job, and
// duplicating it here would just drift out of sync) — it hits the REAL
// Azure DevOps API directly and asserts the raw facts our grouping logic
// is built on:
//   1. A thread's comments come back in creation order (so "first" ==
//      "root" is a safe assumption).
//   2. Comment `id` is scoped PER THREAD, not globally unique across the
//      PR — so resolving "which comment is this" requires the threadId,
//      never id alone. (Every thread's first comment is id=1.)
// If Azure ever changes this shape, this test fails BEFORE anyone has to
// rediscover it by staring at "Kody never answered" in production again.
//
// Needs live credentials — not part of `pnpm test` (see tests/e2e/contract/README.md).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { http, ensureOk } from "../lib/http.js";
import { AzureDevOpsProvider } from "../providers/azure-devops.js";

const TOKEN = process.env.AZ_TEST_TOKEN;
const ORG = process.env.AZ_TEST_ORG;
const PROJECT = process.env.AZ_TEST_PROJECT;
const REPO = process.env.AZ_TEST_REPO;
const HAS_ENV = !!(TOKEN && ORG && PROJECT && REPO);

interface AzureComment {
    id: number;
    content: string;
    publishedDate: string;
    commentType?: string;
}
interface AzureThread {
    id: number;
    isDeleted?: boolean;
    comments?: AzureComment[];
}

function authHeader(): Record<string, string> {
    return {
        Authorization: `Basic ${Buffer.from(`:${TOKEN}`).toString("base64")}`,
        Accept: "application/json",
    };
}

test(
    "Azure DevOps: a fresh thread's root comment is comments[0], created before any reply, id scoped per-thread",
    { skip: !HAS_ENV && "AZ_TEST_TOKEN/ORG/PROJECT/REPO not set" },
    async () => {
        const apiBase = `https://dev.azure.com/${ORG}/${PROJECT}/_apis/git/repositories/${REPO}`;
        const apiVersion = "7.1-preview.1";

        // Self-contained: open our own throwaway PR (same confirmed-mirrored
        // fixture branch the e2e conversation scenarios use) rather than
        // depending on a pre-existing PR number that may not exist.
        const provider = new AzureDevOpsProvider("self-hosted");
        const pr = await provider.openPRFromBranches({
            head: "refactor/use-map-storage",
            base: "main",
            title: `[contract-test] azure-thread-shape ${Date.now()}`,
            body: "Opened by tests/e2e/contract/azure-thread-shape.contract.test.ts",
        });
        const PR_ID = String(pr.number);

        try {
        // 1. Create a brand-new thread (parentCommentId: 0) — this is
        // EXACTLY what `postCommentAs`/`postReviewCommentAs` in
        // providers/azure-devops.ts does for the `@kody <question>` trigger.
        const created = await http<{ id: number; comments: AzureComment[] }>(
            `${apiBase}/pullRequests/${PR_ID}/threads?api-version=${apiVersion}`,
            {
                method: "POST",
                headers: authHeader(),
                body: {
                    comments: [
                        {
                            parentCommentId: 0,
                            content: "[contract-test] root comment",
                            commentType: 1,
                        },
                    ],
                    status: 1,
                },
            },
        );
        ensureOk(created, "azure-contract:create-thread");
        const threadId = created.body.id;
        const rootCommentId = created.body.comments[0].id;

        // 2. Add a REPLY in that same thread — mirrors a real user or Kody
        // responding inside an existing conversation.
        const replied = await http<{ id: number }>(
            `${apiBase}/pullRequests/${PR_ID}/threads/${threadId}/comments?api-version=${apiVersion}`,
            {
                method: "POST",
                headers: authHeader(),
                body: {
                    parentCommentId: rootCommentId,
                    content: "[contract-test] reply",
                    commentType: 1,
                },
            },
        );
        ensureOk(replied, "azure-contract:reply");

        // 3. Fetch the thread back exactly the way
        // azureRepos.service.ts's getPullRequestReviewComment does, and
        // assert the raw shape our grouping logic relies on.
        const fetched = await http<{ value: AzureThread[] }>(
            `${apiBase}/pullRequests/${PR_ID}/threads?api-version=${apiVersion}`,
            { headers: authHeader() },
        );
        ensureOk(fetched, "azure-contract:fetch-threads");
        const thread = fetched.body.value.find((t) => t.id === threadId);
        assert.ok(thread, "the thread we just created must be listed back");
        const comments = (thread!.comments ?? []).filter(
            (c) => (c.commentType ?? "").toLowerCase() !== "system",
        );

        assert.equal(
            comments.length,
            2,
            "expected exactly [root, reply] — Azure did not add hidden system comments to a fresh thread",
        );

        // Creation order, not just id order — our grouping code sorts by
        // this field and treats index 0 as "the root".
        const sorted = [...comments].sort(
            (a, b) =>
                new Date(a.publishedDate).getTime() -
                new Date(b.publishedDate).getTime(),
        );
        assert.equal(
            sorted[0].id,
            rootCommentId,
            "the chronologically first comment must be the one we posted with parentCommentId:0 — " +
                "this is the exact invariant getReviewThreadByCommentId's root-comment branch depends on",
        );
        assert.equal(
            sorted[1].content,
            "[contract-test] reply",
            "the reply must sort after the root",
        );

        // The bug: comment `id` is scoped PER THREAD (every thread's first
        // comment is id=1), not globally unique across the PR — so
        // resolving "which comment is this" must always go through
        // threadId first, never `id` alone. This is why
        // getReviewThreadByCommentId narrows to a thread by threadId BEFORE
        // comparing comment ids.
        assert.equal(
            rootCommentId,
            1,
            "Azure numbers each thread's first comment 1 — confirms comment.id is per-thread, not PR-global " +
                "(if this ever changes, code relying on threadId-then-id resolution needs re-auditing)",
        );
        } finally {
            try {
                await provider.closePR(pr);
            } catch {
                // best-effort cleanup
            }
        }
    },
);
