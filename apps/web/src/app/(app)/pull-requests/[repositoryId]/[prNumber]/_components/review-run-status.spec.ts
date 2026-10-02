import { emptyFindingsLabel } from "./review-run-status";

describe("emptyFindingsLabel", () => {
    it("only calls a PR clean when the review actually ran", () => {
        expect(emptyFindingsLabel("success")).toEqual({
            text: "Nothing to flag.",
            tone: "clean",
        });
    });

    it("keeps the old wording when the run status is unknown", () => {
        expect(emptyFindingsLabel(undefined).tone).toBe("clean");
    });

    it.each([
        ["error", "danger"],
        ["partial_error", "warning"],
        ["skipped", "muted"],
        ["pending", "muted"],
        ["in_progress", "muted"],
    ] as const)("does not read a %s run as a clean pass", (status, tone) => {
        const label = emptyFindingsLabel(status);
        expect(label.tone).toBe(tone);
        expect(label.text).not.toBe("Nothing to flag.");
    });
});
