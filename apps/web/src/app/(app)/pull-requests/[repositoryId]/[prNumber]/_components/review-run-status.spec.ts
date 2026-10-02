import { effectiveReviewStatus, emptyFindingsLabel } from "./review-run-status";

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
