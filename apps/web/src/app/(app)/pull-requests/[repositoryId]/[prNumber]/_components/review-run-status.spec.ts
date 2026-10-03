import {
    effectiveReviewStatus,
    emptyFindingsLabel,
    MAX_RUN_PAGES,
    shouldLoadMoreRuns,
} from "./review-run-status";

describe("emptyFindingsLabel", () => {
    it("only calls a PR clean when the review actually ran", () => {
        expect(emptyFindingsLabel("success")).toEqual({
            text: "Nothing to flag.",
            tone: "clean",
        });
    });

    it("claims nothing while the run status is unknown", () => {
        expect(emptyFindingsLabel(undefined)).toEqual({
            text: "No findings.",
            tone: "muted",
        });
    });

    it.each([
        ["error", "Review failed — nothing to show.", "danger"],
        [
            "partial_error",
            "Review finished with errors — no findings in what it covered.",
            "warning",
        ],
        ["skipped", "Review skipped.", "muted"],
        ["pending", "Review in progress…", "muted"],
        ["in_progress", "Review in progress…", "muted"],
    ] as const)(
        "does not read a %s run as a clean pass",
        (status, text, tone) => {
            expect(emptyFindingsLabel(status)).toEqual({ text, tone });
        },
    );
});

describe("effectiveReviewStatus", () => {
    it.each([
        [["skipped", "success"], "success"],
        [["error", "success"], "success"],
        [["error", "skipped", "success"], "success"],
        [["success", "error"], "success"],
        [["error"], "error"],
        [["skipped", "error"], "skipped"],
        [["in_progress", "success"], "in_progress"],
        [["partial_error", "success"], "partial_error"],
        [[], undefined],
    ] as const)("runs %j read as %s", (runs, expected) => {
        expect(effectiveReviewStatus([...runs])).toBe(expected);
    });
});

describe("shouldLoadMoreRuns", () => {
    const base = {
        hasNextPage: true,
        hasCleanRun: false,
        isFetching: false,
        lastPageFailed: false,
        pagesLoaded: 1,
    };

    it("loads the next page while no clean run is loaded", () => {
        expect(shouldLoadMoreRuns(base)).toBe(true);
    });

    it.each([
        ["there is no next page", { hasNextPage: false }],
        [
            "a clean run turned up (e.g. on page 2)",
            { hasCleanRun: true, pagesLoaded: 2 },
        ],
        ["a fetch is in flight", { isFetching: true }],
        ["the last page failed", { lastPageFailed: true }],
        ["the page cap is reached", { pagesLoaded: MAX_RUN_PAGES }],
    ])("stops when %s", (_, override) => {
        expect(shouldLoadMoreRuns({ ...base, ...override })).toBe(false);
    });

    it("resumes once the failed page is cleared by a successful refetch", () => {
        expect(shouldLoadMoreRuns({ ...base, lastPageFailed: true })).toBe(
            false,
        );
        expect(shouldLoadMoreRuns({ ...base, lastPageFailed: false })).toBe(
            true,
        );
    });
});
