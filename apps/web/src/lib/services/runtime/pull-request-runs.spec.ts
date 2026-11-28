import { typedFetch } from "@services/fetch";

import { queuedRunCount } from "./model/pull-request-runs";
import {
    chunkPullRequests,
    extendPullRequestChunks,
    listPullRequestRuns,
    PULL_REQUESTS_PER_CALL,
    pullRequestRunsKey,
    requestPullRequestRun,
} from "./pull-request-runs";

jest.mock("@services/fetch", () => ({ typedFetch: jest.fn() }));
jest.mock("src/core/utils/helpers", () => ({
    pathToApiUrl: (path: string) => `/api/proxy${path}`,
}));
jest.mock("./queries", () => ({
    runtimeKeys: { runsAll: () => ["runtime", "runs"] },
}));

const prs = (n: number, repositoryId = "repo-1") =>
    Array.from({ length: n }, (_, i) => ({ repositoryId, prNumber: i + 1 }));

describe("the Runtime state of a page of PRs", () => {
    it("is one call per chunk of PRs, never one per PR", () => {
        const chunks = chunkPullRequests([
            ...prs(PULL_REQUESTS_PER_CALL + 10),
            ...prs(3, "repo-2"),
        ]);
        expect(chunks).toHaveLength(2);
        expect(chunks[0]).toHaveLength(PULL_REQUESTS_PER_CALL);
        expect(chunks.flat()).toHaveLength(PULL_REQUESTS_PER_CALL + 13);
    });

    it("drops duplicates, and a chunk's key does not move when its rows reorder", () => {
        const a = { repositoryId: "repo-1", prNumber: 1 };
        const b = { repositoryId: "repo-1", prNumber: 2 };
        expect(chunkPullRequests([a, b, a])).toEqual([[a, b]]);
        expect(pullRequestRunsKey(chunkPullRequests([b, a])[0])).toEqual(
            pullRequestRunsKey(chunkPullRequests([a, b])[0]),
        );
        expect(pullRequestRunsKey([a]).slice(0, 2)).toEqual([
            "runtime",
            "runs",
        ]);
    });

    it("posts the list and reads the answer in or out of the data envelope", async () => {
        (typedFetch as jest.Mock).mockResolvedValueOnce({
            data: { pullRequests: [{ repositoryId: "repo-1", prNumber: 1 }] },
        });
        await expect(listPullRequestRuns(prs(1))).resolves.toEqual([
            { repositoryId: "repo-1", prNumber: 1 },
        ]);
        expect(typedFetch).toHaveBeenCalledWith(
            "/api/proxy/runtime/pull-request-runs",
            {
                method: "POST",
                body: JSON.stringify({ pullRequests: prs(1) }),
            },
        );
        (typedFetch as jest.Mock).mockResolvedValueOnce({ pullRequests: null });
        await expect(listPullRequestRuns(prs(1))).resolves.toEqual([]);
    });
});

// N4: each SSE batch of new PRs became a chunk of its own (often one PR), each polling every 10 s while a
// Run is live. Past a few extra chunks the list is chunked again once: one re-key, then few calls again.
describe("the PR list's chunks over a long session", () => {
    it("keeps the chunks it has while they stay few, and compacts them once they pile up", () => {
        let shown = prs(3);
        let chunks = extendPullRequestChunks([], shown);
        const first = chunks[0];
        for (let n = 4; n <= 6; n++) {
            shown = [{ repositoryId: "repo-1", prNumber: n }, ...shown];
            chunks = extendPullRequestChunks(chunks, shown);
        }
        expect(chunks).toHaveLength(4);
        expect(chunks[0]).toBe(first);
        for (let n = 7; n <= 20; n++) {
            shown = [{ repositoryId: "repo-1", prNumber: n }, ...shown];
            chunks = extendPullRequestChunks(chunks, shown);
        }
        expect(chunks.length).toBeLessThanOrEqual(5);
        expect(chunks.flat()).toHaveLength(shown.length);
    });
});

describe("Run on this PR", () => {
    beforeEach(() => (typedFetch as jest.Mock).mockReset());

    it("names no environment, so the API starts one Run per environment that runs the PR", async () => {
        (typedFetch as jest.Mock).mockResolvedValue({
            data: {
                runId: "r1",
                attempt: 1,
                state: "queued",
                runs: [
                    {
                        environmentId: "e1",
                        runId: "r1",
                        attempt: 1,
                        state: "queued",
                    },
                    {
                        environmentId: "e2",
                        runId: "r2",
                        attempt: 1,
                        state: "queued",
                    },
                ],
            },
        });
        const answer = await requestPullRequestRun({
            repositoryId: "repo-1",
            prNumber: 7,
        });
        expect(
            JSON.parse((typedFetch as jest.Mock).mock.calls[0][1].body),
        ).toEqual({
            repositoryId: "repo-1",
            prNumber: 7,
        });
        expect(queuedRunCount(answer)).toBe(2);
        expect(
            queuedRunCount({ runId: "r", attempt: 1, state: "queued" }),
        ).toBe(1);
    });
});
