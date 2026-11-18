import {
    exercisedThresholdDraft,
    exercisedThresholdWords,
} from "./exercised-lines-threshold";

describe("the org's exercised-lines threshold", () => {
    it("takes a whole percent from 0 to 100, and an empty field as the default", () => {
        expect(exercisedThresholdDraft("")).toEqual({ percent: null });
        expect(exercisedThresholdDraft("  ")).toEqual({ percent: null });
        expect(exercisedThresholdDraft("0")).toEqual({ percent: 0 });
        expect(exercisedThresholdDraft("30")).toEqual({ percent: 30 });
        expect(exercisedThresholdDraft("100")).toEqual({ percent: 100 });
    });

    it.each(["-1", "101", "12.5", "half"])(
        "refuses %s and says why",
        (draft) => {
            expect(exercisedThresholdDraft(draft)).toEqual({
                percent: null,
                error: "Enter a whole number from 0 to 100.",
            });
        },
    );

    it("says which threshold holds: the org's own, the default, or none at 0", () => {
        expect(exercisedThresholdWords(null, 50)).toBe(
            "The default applies: a Run needs 50% of the changed lines to run.",
        );
        expect(exercisedThresholdWords(30, 50)).toBe(
            "Your organization's threshold applies: a Run needs 30% of the changed lines to run.",
        );
        expect(exercisedThresholdWords(0, 50)).toBe(
            "Your organization's threshold is 0%: how many changed lines ran never changes the verdict.",
        );
        expect(exercisedThresholdWords(null, 0)).toBe(
            "The default is 0%: how many changed lines ran never changes the verdict.",
        );
    });
});
