// Contract test: pins the real GitLab MergeRequestDiscussions API shape that
// libs/platform/infrastructure/adapters/services/gitlab.service.ts
// (`getPullRequestReviewComment`, backed by `MergeRequestDiscussions.all()`)
// depends on, and that this session's e2e work relied on when it decided
// GitLab's `postReviewCommentAs` could just delegate to the plain
// `postCommentAs` (no diff-positioned note needed, unlike GitHub).
//
// The assumption: a plain top-level note posted via POST .../notes (no
// `position`) is NOT invisible to MergeRequestDiscussions.all() — GitLab
// auto-wraps every note, positioned or not, into a discussion (a one-note
// discussion for a plain note). If that were false, a brand-new `@kody
// <question>` note would never be found by getPullRequestReviewComment,
// the same failure shape as the Azure bug this session fixed — just for a
// different platform. This test exists so that assumption is verified
// against the real API, not just asserted in a comment.
//
// Needs live credentials — not part of `pnpm test` (see tests/e2e/contract/README.md).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { http, ensureOk } from "../lib/http.js";
import { GitLabProvider } from "../providers/gitlab.js";

const TOKEN = process.env.GL_TEST_TOKEN;
const REPO = process.env.GL_TEST_REPO; // project path, e.g. "kodus-e2e/tiny-url"
const HOST = process.env.GL_HOST ?? "https://gitlab.com";
const HAS_ENV = !!(TOKEN && REPO);

interface GitLabNote {
    id: number;
    body: string;
    created_at: string;
}
interface GitLabDiscussion {
    id: string;
    individual_note?: boolean;
    notes: GitLabNote[];
}

function authHeader(): Record<string, string> {
    return { "PRIVATE-TOKEN": TOKEN! };
}

test(
    "GitLab: a plain note (no position) posted via /notes IS visible as a one-note discussion via /discussions",
    { skip: !HAS_ENV && "GL_TEST_TOKEN/GL_TEST_REPO not set" },
    async () => {
        const apiBase = `${HOST}/api/v4`;
        const projectId = encodeURIComponent(REPO!);

        // Self-contained: open our own throwaway MR (same confirmed-mirrored
        // fixture branch the e2e conversation scenarios use).
        const provider = new GitLabProvider("self-hosted");
        const pr = await provider.openPRFromBranches({
            head: "refactor/use-map-storage",
            base: "main",
            title: `[contract-test] gitlab-discussion-shape ${Date.now()}`,
            body: "Opened by tests/e2e/contract/gitlab-discussion-shape.contract.test.ts",
        });
        const MR_IID = String(pr.number);

        try {
        const marker = `[contract-test] ${Date.now()}`;
        const posted = await http<GitLabNote>(
            `${apiBase}/projects/${projectId}/merge_requests/${MR_IID}/notes`,
            { method: "POST", headers: authHeader(), body: { body: marker } },
        );
        ensureOk(posted, "gitlab-contract:post-note");

        const discussions = await http<GitLabDiscussion[]>(
            `${apiBase}/projects/${projectId}/merge_requests/${MR_IID}/discussions`,
            { headers: authHeader() },
        );
        ensureOk(discussions, "gitlab-contract:list-discussions");

        const found = discussions.body
            .flatMap((d) => d.notes.map((n) => ({ discussion: d, note: n })))
            .find(({ note }) => note.id === posted.body.id);

        assert.ok(
            found,
            "a plain note (no `position`) posted to /notes must be findable via /discussions — " +
                "if this ever fails, GitLab's getPullRequestReviewComment (backed by " +
                "MergeRequestDiscussions.all()) would silently stop seeing brand-new @kody mentions, " +
                "the same failure class as the Azure DevOps bug fixed this session",
        );
        assert.equal(
            found!.discussion.notes.length,
            1,
            "a plain note must be wrapped into a ONE-note discussion, not merged into something else",
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
