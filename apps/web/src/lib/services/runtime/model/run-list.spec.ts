import type { RuntimeRunSummary } from "../contracts";
import { runListRow } from "./run-list";

const run = (patch: Partial<RuntimeRunSummary> = {}): RuntimeRunSummary => ({
    runId: "run-1",
    attempt: 1,
    repositoryId: "r1",
    repositoryName: "acme/shop",
    prNumber: 42,
    headSha: "a".repeat(40),
    state: "no_regressions",
    requestedAt: "2026-11-10T12:00:00.000Z",
    startedAt: "2026-11-10T12:00:30.000Z",
    finishedAt: "2026-11-10T12:10:30.000Z",
    ...patch,
});

describe("a row of the Runs list", () => {
    it("reads its verdict once: a check title that repeats the state adds nothing", () => {
        const row = runListRow(
            run({
                state: "partly_tested",
                check: { conclusion: "neutral", title: "Partly tested" },
            }),
        );
        expect(row.verdict).toEqual({ label: "Partly tested", tone: "alert" });
        expect(row.detail).toBeUndefined();
    });

    it("drops a check title that only restates the state in a longer sentence", () => {
        for (const [state, title] of [
            ["no_regressions", "No regressions in what was tested"],
            ["nothing_to_test", "Nothing to test at runtime"],
        ] as const) {
            const row = runListRow(
                run({ state, check: { conclusion: "success", title } }),
            );
            expect(row.detail).toBeUndefined();
        }
    });

    it("keeps only what the check title says beyond the state", () => {
        expect(
            runListRow(
                run({
                    state: "partly_tested",
                    check: {
                        conclusion: "neutral",
                        title: "Partly tested · 3 blocked outbound requests",
                    },
                }),
            ).detail,
        ).toBe("3 blocked outbound requests");
        expect(
            runListRow(
                run({
                    state: "regression",
                    check: { conclusion: "failure", title: "1 regression" },
                }),
            ).detail,
        ).toBe("1 regression");
    });

    it("a live Run shows no check: the API fills one from the state table", () => {
        const row = runListRow(
            run({
                state: "testing",
                finishedAt: undefined,
                check: { conclusion: "neutral", title: "Testing" },
            }),
        );
        expect(row.detail).toBeUndefined();
        expect(row.duration).toEqual({ text: "Running", measured: false });
    });

    it("a Run not started yet has no duration to show", () => {
        expect(
            runListRow(
                run({
                    state: "queued",
                    startedAt: undefined,
                    finishedAt: undefined,
                }),
            ).duration,
        ).toEqual({ text: "Not started", measured: false });
    });

    it("a finished Run lasts from its start to its end", () => {
        expect(runListRow(run()).duration).toEqual({
            text: "10 min 00 s",
            measured: true,
        });
    });

    it("says the attempt only from the second one on", () => {
        expect(runListRow(run()).attempt).toBeUndefined();
        expect(runListRow(run({ attempt: 3 })).attempt).toBe("attempt 3");
    });

    it("names the Run by its pull request's title when the Run recorded one", () => {
        expect(
            runListRow(run({ prTitle: "  fix(orders): coupon total  " }))
                .prTitle,
        ).toBe("fix(orders): coupon total");
    });

    it.each([undefined, "", "   "])(
        "an older Run without a title keeps its number (%j)",
        (prTitle) => {
            expect(runListRow(run({ prTitle })).prTitle).toBeUndefined();
        },
    );
});
