import {
    neutralReasonsOfTitle,
    parseNeutralReasons,
    runFacts,
    runRecipeSource,
} from "./run-facts";

describe("runFacts", () => {
    it("reads only the gate's own neutral phrases", () => {
        expect(
            parseNeutralReasons([
                "2 blocked outbound requests",
                "dependency change not behavior-tested",
                "diff too large to test whole",
                "something the app printed",
            ]),
        ).toEqual({
            blockedOutbound: 2,
            dependencyChangeUntested: true,
            diffTruncated: true,
        });
        expect(
            parseNeutralReasons(["1 blocked outbound request"]),
        ).toMatchObject({ blockedOutbound: 1 });
    });

    it("falls back to the check title when the stream is gone", () => {
        expect(
            neutralReasonsOfTitle(
                "No regressions · 1 blocked outbound request",
            ),
        ).toEqual(["1 blocked outbound request"]);
        expect(
            runFacts({
                check: {
                    conclusion: "neutral",
                    title: "No regressions · dependency change not behavior-tested",
                },
                recipeChangedInPr: [".kodus/workspace.yaml"],
            }),
        ).toEqual({
            dependencyChangeUntested: true,
            diffTruncated: false,
            recipeChangedInPr: [".kodus/workspace.yaml"],
        });
    });

    it("keeps the refused probes and the plan check's reasons, three at most", () => {
        expect(
            runFacts(
                { check: { conclusion: "neutral", title: "Partly tested" } },
                {
                    verdict: {
                        at: "t",
                        rejectedProbes: 4,
                        rejectedReasons: ["a", " b ", "", "c", "d"],
                    },
                },
            ).rejectedProbes,
        ).toEqual({ count: 4, reasons: ["a", "b", "c"] });
        expect(
            runFacts({}, { verdict: { at: "t", rejectedProbes: 0 } })
                .rejectedProbes,
        ).toBeUndefined();
    });

    it("prefers the verdict event's list over the title", () => {
        expect(
            runFacts(
                {
                    check: {
                        conclusion: "neutral",
                        title: "Partly tested · 3 blocked outbound requests",
                    },
                },
                { verdict: { at: "t", forcedNeutral: [] } },
            ).blockedOutbound,
        ).toBeUndefined();
    });
});

describe("runRecipeSource", () => {
    const recipe = {
        sha: "239a4415903c",
        state: "found" as const,
        prChangesRecipe: false,
    };
    it("says where the setup file came from: a sent or written one is not read from the base branch", () => {
        expect(
            runRecipeSource({ ...recipe, origin: "submitted" }, "main"),
        ).toBe("Sent from a coding agent");
        expect(runRecipeSource({ ...recipe, origin: "authored" }, "main")).toBe(
            "Written by Kody",
        );
        expect(runRecipeSource({ ...recipe, origin: "inferred" }, "main")).toBe(
            "Inferred by Kodus",
        );
        expect(
            runRecipeSource({ ...recipe, origin: "repository" }, "main"),
        ).toBe("Committed in main at 239a441");
        // A Run recorded before origins were: the base branch's, as before.
        expect(runRecipeSource(recipe, "main")).toBe(
            "Committed in main at 239a441",
        );
    });

    it("says when there was none, or when the Run did not record it", () => {
        expect(runRecipeSource({ ...recipe, state: "absent" }, "main")).toBe(
            "No setup file",
        );
        expect(runRecipeSource(undefined, "main")).toBe(
            "The environment's setup file",
        );
    });
});
