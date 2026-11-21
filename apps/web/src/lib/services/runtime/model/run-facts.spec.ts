import {
    neutralReasonsOfTitle,
    parseNeutralReasons,
    runFacts,
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
