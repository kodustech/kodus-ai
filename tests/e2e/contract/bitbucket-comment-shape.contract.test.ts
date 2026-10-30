// Contract test: pins the real Bitbucket PR-comments API shape that
// libs/platform/infrastructure/adapters/services/bitbucket/bitbucket-cloud.service.ts
// (`getPullRequestReviewComment`) and tests/e2e/providers/bitbucket.ts
// (`pollForKodyReply`) depend on.
//
// Bug this exists to catch: Bitbucket's acknowledgment comment
// ("Analyzing your request...", posted by
// AzureReposResponsePolicy/BitbucketResponsePolicy before the real answer)
// carries no `<!-- kody-codereview -->` marker, and it is a perfectly
// ordinary top-level PR comment — indistinguishable, at the API level, from
// Kody's real terminal answer. providers/bitbucket.ts's pollForKodyReply
// returned it as if it were the answer (a false green: caught live during
// this session's validation — a "passing" run's replySample came back as
// literally "Analyzing your request..."). Fixed by an explicit text-prefix
// skip in pollForKodyReply.
//
// This test does not re-run that filter (the unit-level equivalent is the
// filter's own logic, exercised live by the e2e scenario) — it pins the
// external fact the bug depended on: Bitbucket's plain comments-list
// endpoint returns EVERY top-level comment, ack included, with no
// discriminating field between "acknowledgment" and "terminal answer" other
// than content — and `created_on` sorts correctly as an ISO string, which
// pollForKodyReply's sinceIso comparison relies on.
//
// Needs live credentials — not part of `pnpm test` (see tests/e2e/contract/README.md).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { http, ensureOk } from "../lib/http.js";
import { BitbucketProvider } from "../providers/bitbucket.js";

const USER = process.env.BB_TEST_USER;
const APP_PASSWORD = process.env.BB_TEST_APP_PASSWORD;
const WORKSPACE = process.env.BB_TEST_REPO; // "workspace/slug"
const HAS_ENV = !!(USER && APP_PASSWORD && WORKSPACE);

interface BitbucketComment {
    id: number;
    content: { raw: string };
    created_on: string;
}

function authHeader(): Record<string, string> {
    return {
        Authorization: `Basic ${Buffer.from(`${USER}:${APP_PASSWORD}`).toString("base64")}`,
        Accept: "application/json",
    };
}

test(
    "Bitbucket: an ack-shaped comment and a terminal-answer-shaped comment are indistinguishable except by content, and created_on is lexically sortable",
    { skip: !HAS_ENV && "BB_TEST_USER/APP_PASSWORD/REPO not set" },
    async () => {
        const apiBase = "https://api.bitbucket.org/2.0";
        const sinceIso = new Date().toISOString();

        // Self-contained: open our own throwaway PR (same confirmed-mirrored
        // fixture branch the e2e conversation scenarios use).
        const provider = new BitbucketProvider("self-hosted");
        const pr = await provider.openPRFromBranches({
            head: "refactor/use-map-storage",
            base: "main",
            title: `[contract-test] bitbucket-comment-shape ${Date.now()}`,
            body: "Opened by tests/e2e/contract/bitbucket-comment-shape.contract.test.ts",
        });
        const PR_ID = String(pr.number);

        try {
        // Post two comments in the exact sequence handleConversationFlow
        // produces for Bitbucket (requiresAcknowledgment()=true): the ack
        // first, the real answer second — same endpoint, same shape, no
        // special "this is an ack" field on either.
        const ack = await http<BitbucketComment>(
            `${apiBase}/repositories/${WORKSPACE}/pullrequests/${PR_ID}/comments`,
            {
                method: "POST",
                headers: authHeader(),
                body: { content: { raw: "Analyzing your request..." } },
            },
        );
        ensureOk(ack, "bitbucket-contract:post-ack");

        const answer = await http<BitbucketComment>(
            `${apiBase}/repositories/${WORKSPACE}/pullrequests/${PR_ID}/comments`,
            {
                method: "POST",
                headers: authHeader(),
                body: {
                    content: { raw: "[contract-test] the real terminal answer" },
                },
            },
        );
        ensureOk(answer, "bitbucket-contract:post-answer");

        const listed = await http<{ values: BitbucketComment[] }>(
            `${apiBase}/repositories/${WORKSPACE}/pullrequests/${PR_ID}/comments?pagelen=50&sort=-created_on`,
            { headers: authHeader() },
        );
        ensureOk(listed, "bitbucket-contract:list");

        const ours = listed.body.values.filter(
            (c) => c.created_on > sinceIso,
        );
        assert.equal(
            ours.length,
            2,
            "both the ack and the answer must come back from the plain comments-list endpoint — " +
                "confirms there is no separate 'system'/'ack' comment type to filter on",
        );

        const ackFetched = ours.find((c) => c.id === ack.body.id);
        const answerFetched = ours.find((c) => c.id === answer.body.id);
        assert.ok(ackFetched && answerFetched);

        // The only thing that can distinguish them is content — no
        // `commentType`, no marker field. This is exactly why the fix has
        // to be a text-prefix check, not a structural one.
        assert.deepEqual(
            Object.keys(ackFetched!).sort(),
            Object.keys(answerFetched!).sort(),
            "an ack comment and a real answer must have identical field shapes",
        );

        // pollForKodyReply filters with `c.created_on <= opts.sinceIso` —
        // a plain string comparison. Confirm Bitbucket's created_on is a
        // zero-padded ISO 8601 string that sorts correctly that way (not,
        // say, a non-padded or locale-formatted timestamp).
        assert.ok(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+\+00:00$/.test(
                ackFetched!.created_on,
            ),
            `created_on must be zero-padded ISO 8601 for string comparison to sort correctly, got: ${ackFetched!.created_on}`,
        );
        assert.ok(
            ackFetched!.created_on < answerFetched!.created_on,
            "the ack (posted first) must sort before the answer (posted second) under plain string comparison",
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
