import { getReviewedPullRequestCount, PULL_REQUEST_API } from "./fetch";

const authorizedFetchMock = jest.fn();
jest.mock("@services/fetch", () => ({
    authorizedFetch: (...args: unknown[]) => authorizedFetchMock(...args),
}));
jest.mock("src/core/utils/helpers", () => ({
    pathToApiUrl: (path: string) => path,
}));

const query = (url: string) =>
    Object.fromEntries(new URLSearchParams(url.split("?")[1] ?? ""));

describe("PULL_REQUEST_API", () => {
    it("asks the totals endpoint for the DB-level filters only", () => {
        const url = PULL_REQUEST_API.GET_EXECUTIONS_TOTALS({
            teamId: "team-1",
            repositoryName: "api",
            pullRequestTitle: "fix login",
            pullRequestNumber: "42",
            status: "error",
            createdAtFrom: "2026-01-01",
            createdAtTo: "2026-01-31T23:59:59.999",
            // none of these change a count
            limit: 30,
            cursor: "abc",
            authorPolicy: "reviewable",
            severity: "high",
            author: "me",
            prState: "open",
            needsAttention: true,
            hasSentSuggestions: true,
        });

        expect(url.split("?")[0]).toBe("/pull-requests/executions/totals");
        expect(query(url)).toEqual({
            teamId: "team-1",
            repositoryName: "api",
            pullRequestTitle: "fix login",
            pullRequestNumber: "42",
            status: "error",
            createdAtFrom: "2026-01-01",
            createdAtTo: "2026-01-31T23:59:59.999",
        });
    });

    it("names the facets a view renders", () => {
        expect(
            query(
                PULL_REQUEST_API.GET_FACETS("team-1", "team", [
                    "awaiting",
                    "needsAttention",
                ]),
            ),
        ).toEqual({ teamId: "team-1", fields: "awaiting,needsAttention" });

        // No list → the backend's default set, same URL as before.
        expect(PULL_REQUEST_API.GET_FACETS("team-1")).toBe(
            "/pull-requests/executions/facets?teamId=team-1",
        );
        expect(
            query(PULL_REQUEST_API.GET_FACETS("team-1", "mine", ["mine"])),
        ).toEqual({ teamId: "team-1", scope: "mine", fields: "mine" });
    });

    it("names the digest counts a view renders", () => {
        expect(
            query(
                PULL_REQUEST_API.GET_DAILY_DIGEST("team-1", ["reviewedToday"]),
            ),
        ).toEqual({ teamId: "team-1", fields: "reviewedToday" });
        expect(PULL_REQUEST_API.GET_DAILY_DIGEST("team-1")).toBe(
            "/pull-requests/executions/summary?teamId=team-1",
        );
    });

    it("does not send a total request with the list", () => {
        const url = PULL_REQUEST_API.GET_EXECUTIONS({
            teamId: "team-1",
            limit: 30,
        });

        expect(query(url)).toEqual({ teamId: "team-1", limit: "30" });
    });
});

describe("getReviewedPullRequestCount", () => {
    beforeEach(() => {
        authorizedFetchMock.mockReset();
    });

    it("reads the distinct-PR total from the totals endpoint", async () => {
        authorizedFetchMock.mockResolvedValueOnce({
            totalItems: 30,
            distinctPrTotal: 12,
        });

        await expect(
            getReviewedPullRequestCount({
                teamId: "team-1",
                status: "success",
            }),
        ).resolves.toBe(12);

        expect(authorizedFetchMock).toHaveBeenCalledTimes(1);
        const [url] = authorizedFetchMock.mock.calls[0];
        expect(url.split("?")[0]).toBe("/pull-requests/executions/totals");
        expect(query(url)).toEqual({ teamId: "team-1", status: "success" });
    });

    it("tells an empty workspace (0) apart from an unknown count", async () => {
        authorizedFetchMock.mockResolvedValueOnce({
            totalItems: 0,
            distinctPrTotal: 0,
        });

        await expect(
            getReviewedPullRequestCount({ teamId: "team-1" }),
        ).resolves.toBe(0);
    });

    it("falls back to the list on an API that predates the totals endpoint", async () => {
        authorizedFetchMock
            .mockRejectedValueOnce(new Error("404"))
            .mockResolvedValueOnce({
                data: [{}],
                pagination: { totalItems: 9, distinctPrTotal: 4 },
            });

        await expect(
            getReviewedPullRequestCount({ teamId: "team-1", windowDays: 30 }),
        ).resolves.toBe(4);

        const [listUrl] = authorizedFetchMock.mock.calls[1];
        expect(listUrl.split("?")[0]).toBe("/pull-requests/executions");
        expect(query(listUrl)).toMatchObject({ teamId: "team-1", limit: "1" });
        expect(query(listUrl).createdAtFrom).toEqual(expect.any(String));
    });

    it("answers null when the count cannot be established", async () => {
        authorizedFetchMock
            .mockRejectedValueOnce(new Error("404"))
            .mockRejectedValueOnce(new Error("500"));

        await expect(
            getReviewedPullRequestCount({ teamId: "team-1" }),
        ).resolves.toBeNull();

        await expect(getReviewedPullRequestCount({})).resolves.toBeNull();
    });
});
