import type { RunStepView } from "../stream";
import {
    healthRegressionRun,
    healthRegressionView,
} from "./__fixtures__/run-detail";
import {
    buildRunPaths,
    checkLabel,
    OUTSIDE_DIFF_MARKER,
    resultOf,
    shownRouteOf,
} from "./run-paths";

const step = (
    patch: Partial<RunStepView> & { stepId: string },
): RunStepView => ({
    startedAt: "2026-10-31T14:02:09.112Z",
    finishedAt: "2026-10-31T14:02:09.388Z",
    durationMs: 276,
    ...patch,
});

describe("buildRunPaths (screen 8)", () => {
    it("distinguishes absent coverage metadata from an explicitly empty uncovered list", () => {
        expect(buildRunPaths({ probes: [] }, []).coverageKnown).toBe(false);
        expect(
            buildRunPaths({ probes: [], uncoveredEntryPoints: [] }, [])
                .coverageKnown,
        ).toBe(true);
    });

    const run = {
        baseBranch: "main",
        probes: [
            {
                probeId: "orders-list",
                entryPoint: "GET /orders",
                verdict: "not_reproduced" as const,
                reason: "same on both sides",
                baseStepIds: ["b2"],
                prStepIds: ["p2"],
            },
            {
                probeId: "empty-cart",
                entryPoint: "POST /orders",
                verdict: "finding" as const,
                intent: "unintended" as const,
                reason: "status differs",
                differingFields: ["status"],
                baseStepIds: ["b1", "b1b"],
                prStepIds: ["p1"],
            },
            {
                probeId: "pay",
                entryPoint: "POST /payments",
                verdict: "blocker" as const,
                reason: "no key",
            },
        ],
        uncoveredEntryPoints: ["POST /payments", "DELETE /orders/:id"],
    };
    const steps = [
        step({ stepId: "b1", side: "base", status: 400 }),
        step({ stepId: "b1b", side: "base", status: 400 }),
        step({ stepId: "p1", side: "pr", status: 500 }),
        step({ stepId: "b2", side: "base", status: 200 }),
        step({ stepId: "p2", side: "pr", status: 200 }),
    ];

    it.each(["release/2026", undefined, "  "])(
        "labels the recorded base without assuming main (%j)",
        (baseBranch) => {
            const label = baseBranch?.trim() || "base version";
            const [path] = buildRunPaths({ ...run, baseBranch }, steps).paths;
            expect(path.summary).toBe(`400 on ${label}, 500 on this PR`);
            expect(path.steps[0].title).toContain(`on ${label}`);
            expect(path.steps.find((s) => s.side === "pr")?.expected).toBe(
                `400, like ${label}`,
            );
        },
    );

    it("puts regressions first and says what each side answered", () => {
        const { paths } = buildRunPaths(run, steps);
        expect(paths.map((p) => [p.entryPoint, p.outcome, p.summary])).toEqual([
            ["POST /orders", "regression", "400 on main, 500 on this PR"],
            ["POST /payments", "could_not_test", "could not test"],
            ["GET /orders", "same", "200 on main, 200 on this PR"],
        ]);
    });

    it("each step has expected vs observed, the time and whether it held", () => {
        const [regression] = buildRunPaths(run, steps).paths;
        expect(regression.steps).toEqual([
            expect.objectContaining({
                side: "base",
                title: "Send POST /orders on main (attempt 1)",
                observed: "400",
                ok: true,
            }),
            expect.objectContaining({
                side: "base",
                title: "Send POST /orders on main (attempt 2)",
                observed: "400",
                ok: true,
            }),
            expect.objectContaining({
                side: "pr",
                title: "Send the same request on this PR",
                expected: "400, like main",
                observed: "500",
                ok: false,
                startedAt: "2026-10-31T14:02:09.112Z",
            }),
        ]);
    });

    it("a body difference with the same status names the fields", () => {
        const sameStatus = {
            probes: [
                { ...run.probes[1], differingFields: ["status", "json.total"] },
            ],
        };
        const out = buildRunPaths(sameStatus, [
            step({ stepId: "b1", side: "base", status: 200 }),
            step({ stepId: "p1", side: "pr", status: 200 }),
        ]).paths[0];
        expect(out.steps.at(-1)).toMatchObject({
            observed: "200, differs in json.total",
            ok: false,
        });
    });

    it("lists entry points no probe reached, once", () => {
        expect(buildRunPaths(run, steps).untested).toEqual([
            { entryPoint: "DELETE /orders/:id", reason: "No check reached it" },
        ]);
    });

    it("counts tested paths from the same rows the screen draws", () => {
        // findings and probes overlap: the count follows the de-duplicated rows.
        const out = buildRunPaths({ ...run, findings: [run.probes[1]] }, steps);
        expect(out.paths).toHaveLength(3);
        expect(out.testedCount).toBe(2);
        expect(out.totalCount).toBe(4);
    });

    it("a step still running or missing from the stream is said so", () => {
        expect(resultOf(undefined)).toBe("not recorded");
        expect(resultOf({ stepId: "x" })).toBe("running");
        expect(resultOf(step({ stepId: "x", transport: "lost" }))).toBe(
            "no answer",
        );
        expect(resultOf(step({ stepId: "x", exitCode: 1 }))).toBe("exit 1");
    });
});

describe("a probe outside this PR's paths", () => {
    const outside = {
        probeId: "health",
        entryPoint: "unmapped",
        exercised: "GET /api/health",
        verdict: "not_reproduced" as const,
        reason: "same",
        baseStepIds: ["b9"],
        prStepIds: ["p9"],
    };

    it("counts unique changed paths, excluding observations outside the diff even when stream details expired", () => {
        const compared = {
            ...outside,
            entryPoint: "POST /orders",
            probeId: "order-a",
        };
        const out = buildRunPaths(
            {
                probes: [
                    outside,
                    compared,
                    { ...compared, probeId: "order-b" },
                ],
                uncoveredEntryPoints: [
                    "DELETE /orders/:id",
                    "DELETE /orders/:id",
                ],
            },
            [],
        );
        expect(out.paths).toHaveLength(3);
        expect(out.testedCount).toBe(1);
        expect(out.totalCount).toBe(2);
        expect(out.untested).toHaveLength(1);
    });

    it("shows what it sent with the marker, never the bare 'unmapped'", () => {
        const out = buildRunPaths(
            { probes: [outside], uncoveredEntryPoints: ["POST /orders"] },
            [
                step({ stepId: "b9", side: "base", status: 200 } as any),
                step({ stepId: "p9", side: "pr", status: 200 } as any),
            ],
        );
        expect(out.paths[0]).toMatchObject({
            route: "GET /api/health",
            outsideDiff: true,
            entryPoint: "unmapped",
        });
        expect(out.paths[0].steps[0].title).toBe(
            "Send GET /api/health on base version",
        );
        // It still covers nothing: the diff's entry point stays untested.
        expect(out.untested).toEqual([
            { entryPoint: "POST /orders", reason: "No check reached it" },
        ]);
        expect(OUTSIDE_DIFF_MARKER).toBe("outside this PR's paths");
    });

    it("falls back to a neutral route for an older Run without the label", () => {
        const { exercised: _, ...old } = outside;
        expect(shownRouteOf(old)).toEqual({
            route: "A path",
            outsideDiff: true,
        });
        expect(shownRouteOf({ entryPoint: "GET /orders" })).toEqual({
            route: "GET /orders",
            outsideDiff: false,
        });
    });
});

describe("replay lanes on a path", () => {
    it("keeps the verdict's lanes for the path's evidence, and none on an older Run", () => {
        const [path] = buildRunPaths(
            healthRegressionRun(),
            healthRegressionView().steps,
        ).paths;
        expect(path.lanes?.pr.stepId).toBe("hp1");
        const old = buildRunPaths(
            healthRegressionRun({
                probes: healthRegressionRun().probes!.map(
                    ({ lanes: _l, ...p }) => p,
                ),
            }),
            [],
        ).paths[0];
        expect(old).not.toHaveProperty("lanes");
    });
});

describe("checkLabel", () => {
    it("tells two checks of one route apart by what each set out to check", () => {
        expect(checkLabel("signup-invalid-email")).toBe("Signup invalid email");
        expect(checkLabel("signup-password-no-symbol")).toBe(
            "Signup password no symbol",
        );
        expect(checkLabel("signup-invalid-email", "  An email without @  ")).toBe(
            "An email without @",
        );
    });

    it("names no check whose id is opaque", () => {
        expect(checkLabel("3f2a9c1e-77b0-4c5e-9a1d-0b6e2f8c4d11")).toBeUndefined();
        expect(checkLabel("1234")).toBeUndefined();
    });
});
