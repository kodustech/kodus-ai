import { emptyFindingsLabel } from "./review-run-status";

describe("emptyFindingsLabel", () => {
    it("only calls a PR clean when the review actually ran", () => {
        expect(emptyFindingsLabel("success")).toEqual({
            text: "Nothing to flag.",
            tone: "clean",
        });
    });

    it("keeps the old wording when the run status is unknown", () => {
        expect(emptyFindingsLabel(undefined)).toEqual({
            text: "Nothing to flag.",
            tone: "clean",
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
