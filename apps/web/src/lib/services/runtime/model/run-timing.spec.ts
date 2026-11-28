import { EMPTY_RUN_STREAM_VIEW } from "../stream";
import {
    at,
    partlyTestedRun,
    partlyTestedView,
} from "./__fixtures__/run-detail";
import { plainText } from "./rich-text";
import {
    buildStepsLine,
    runTiming,
    shortStepName,
    timingSummary,
    timingTakeaway,
} from "./run-timing";

describe("runTiming", () => {
    it("splits boot and build from phaseMs, test and report from the stream", () => {
        const timing = runTiming(partlyTestedRun(), partlyTestedView());
        expect(timing.phases.map((p) => [p.id, p.ms])).toEqual([
            ["wait", 20_000],
            ["boot", 14_000],
            ["apply", 471_000],
            ["test", 68_000],
            ["report", 3_000],
        ]);
        expect(timing.totalMs).toBe(591_000);
        expect(timing.phases.find((p) => p.id === "test")?.detail).toBe(
            "1 check · 2 attempts on main, 1 on this PR",
        );
        expect(
            timing.phases.find((p) => p.id === "apply")?.builds?.[0].side,
        ).toBe("pr");
        expect(timingSummary(timing)).toContain("Build this PR 7 min 51 s");
    });

    it("without phaseMs, one boot phase from bootMs; without a stream, no test phase", () => {
        const timing = runTiming(
            partlyTestedRun({ phaseMs: undefined, bootMs: 485_000 }),
            EMPTY_RUN_STREAM_VIEW,
        );
        expect(timing.phases.map((p) => [p.id, p.label, p.ms])).toEqual([
            ["wait", "Wait for a free machine", 20_000],
            ["boot", "Boot main and build this PR", 485_000],
        ]);
    });

    it("a live Run counts the test up to now", () => {
        const view = partlyTestedView();
        const live = {
            ...view,
            states: view.states.slice(0, 3),
            verdict: undefined,
            published: [],
        };
        const timing = runTiming(
            partlyTestedRun({ state: "testing", finishedAt: undefined }),
            live,
            Date.parse(at(515)),
        );
        expect(timing.phases.find((p) => p.id === "test")).toMatchObject({
            ms: 10_000,
            running: true,
        });
        expect(timing.totalMs).toBe(515_000);
    });

    it("a Run still booting counts the boot up to now instead of 'not measured'", () => {
        const view = partlyTestedView();
        const timing = runTiming(
            partlyTestedRun({
                state: "booting",
                phaseMs: undefined,
                finishedAt: undefined,
            }),
            {
                ...view,
                states: view.states.slice(0, 2),
                verdict: undefined,
                published: [],
            },
            Date.parse(at(320)),
        );
        expect(timing.phases.find((p) => p.id === "boot")).toMatchObject({
            ms: 300_000,
            running: true,
        });
    });

    it("prints a build's counts", () => {
        expect(
            buildStepsLine({
                side: "pr",
                steps: 12,
                done: 11,
                cached: 9,
                errored: 1,
                slowest: [],
            }),
        ).toBe("12 steps · 9 cached · 1 failed");
    });
});

describe("timingTakeaway", () => {
    const takeaway = (...args: Parameters<typeof runTiming>) =>
        plainText(timingTakeaway(runTiming(...args), { live: false }) ?? []);

    it("says which phase took most of the time, and its slowest step", () => {
        expect(takeaway(partlyTestedRun(), partlyTestedView())).toBe(
            "Most of it was building this PR (7 min 51 s); its slowest step was app make build-go (6 min 40 s).",
        );
    });

    it("explains a wait for a machine as a queue Kody had not started on", () => {
        const run = partlyTestedRun({
            bootingAt: at(400),
            phaseMs: { boot: 30_000, apply: 40_000 },
            buildSteps: [],
        });
        expect(takeaway(run, partlyTestedView())).toBe(
            "Most of it was waiting for a free machine (6 min 40 s): the Run was queued until a Kodus machine was free, and Kody had not started yet.",
        );
        expect(
            plainText(
                timingTakeaway(
                    runTiming(
                        { ...run, cellOwner: "customer" },
                        partlyTestedView(),
                    ),
                    { live: false },
                ) ?? [],
            ),
        ).toContain("until one of your machines was free");
    });

    it("counts the testing as checks × versions × attempts", () => {
        const run = partlyTestedRun({
            phaseMs: { boot: 4_000, apply: 6_000 },
            buildSteps: [],
            probes: [
                {
                    probeId: "a",
                    entryPoint: "GET /a",
                    verdict: "not_reproduced",
                    reason: "same",
                    baseStepIds: ["a1", "a2"],
                    prStepIds: ["a3", "a4"],
                },
                {
                    probeId: "b",
                    entryPoint: "GET /b",
                    verdict: "not_reproduced",
                    reason: "same",
                    baseStepIds: ["b1", "b2"],
                    prStepIds: ["b3", "b4"],
                },
            ],
        });
        const view = partlyTestedView();
        const testing = view.states.find((s) => s.state === "testing")!;
        const timing = runTiming(run, {
            ...view,
            states: view.states.map((s) =>
                s === testing ? { ...s, at: at(40) } : s,
            ),
        });
        expect(timing.phases.find((p) => p.id === "test")?.detail).toBe(
            "2 checks · 2 attempts on each version",
        );
        expect(plainText(timingTakeaway(timing, { live: false })!)).toBe(
            "Most of it was testing (8 min 53 s): 2 checks × 2 versions × 2 attempts.",
        );
    });

    it("says 'the longest part' when no phase took half of the time", () => {
        const run = partlyTestedRun({
            phaseMs: { boot: 200_000, apply: 210_000 },
            buildSteps: [],
            bootTiming: undefined,
        });
        expect(takeaway(run, partlyTestedView())).toBe(
            "The longest part was building this PR (3 min 30 s).",
        );
    });

    it("says 'so far' while the Run is live", () => {
        const view = partlyTestedView();
        const timing = runTiming(
            partlyTestedRun({ state: "testing", finishedAt: undefined }),
            {
                ...view,
                states: view.states.slice(0, 3),
                verdict: undefined,
                published: [],
            },
            Date.parse(at(515)),
        );
        expect(plainText(timingTakeaway(timing, { live: true })!)).toMatch(
            /^So far, most of it was building this PR/,
        );
    });

    it("has nothing to say before a phase is measured", () => {
        expect(
            timingTakeaway(
                runTiming(
                    partlyTestedRun({
                        state: "queued",
                        bootingAt: undefined,
                        phaseMs: undefined,
                        finishedAt: undefined,
                    }),
                    EMPTY_RUN_STREAM_VIEW,
                ),
                { live: true },
            ),
        ).toBeUndefined();
    });
});

describe("shortStepName", () => {
    it("keeps the command of a BuildKit step, without its stage, RUN and mount flags", () => {
        expect(
            shortStepName(
                "[build 3/3] RUN --mount=type=cache,target=/usr/src/app/node_modules/.cache,sharing=locked pnpm run build:apps",
            ),
        ).toBe("pnpm run build:apps");
    });

    it("cuts a long command at 60 characters", () => {
        const name = shortStepName(`RUN ${"x".repeat(80)}`);
        expect(name).toHaveLength(60);
        expect(name.endsWith("…")).toBe(true);
    });
});
