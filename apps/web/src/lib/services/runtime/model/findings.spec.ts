import {
    bootRegressionRun,
    healthRegressionRun,
    healthRegressionView,
    newRouteRun,
    newRouteView,
    regressionRun,
    regressionView,
} from "./__fixtures__/run-detail";
import {
    buildFindings,
    changeLine,
    evidenceKindOf,
    reviewSuggestionHref,
    withIntentResult,
} from "./findings";

describe("buildFindings", () => {
    it("puts regressions first, each with both sides round by round", () => {
        const [regression, intended] = buildFindings(
            regressionRun(),
            regressionView().steps,
        );
        expect(regression).toMatchObject({
            entryPoint: "POST /orders",
            intended: false,
            change: "status 201 → 500 · json.error differs",
            proof: "Same request, 2 attempts on main and 2 on this PR, the same answer every attempt",
            evidenceKind: "http",
            reproducible: true,
        });
        expect(regression.base.rounds.map((r) => r.answer)).toEqual([
            "201",
            "201",
        ]);
        expect(regression.pr).toMatchObject({
            answer: "500",
            steady: true,
            sha: regressionRun().headSha,
        });
        expect(intended).toMatchObject({
            entryPoint: "GET /orders/:id",
            intended: true,
            reproducible: false,
        });
        expect(intended.change).toBe("json.total_before_tax differs");
    });

    it("an intended finding says its evidence: the values the diff swaps, or a pre-existing test", () => {
        const run = regressionRun();
        const change = {
            field: "step.2.value",
            base: "Production-ready configuration",
            pr: "Production configuration, ready to deploy",
            file: "examples/with-docker/app/page.tsx",
            line: 35,
        };
        const byDiff = buildFindings(
            {
                ...run,
                probes: run.probes!.map((p) =>
                    p.verdict === "finding"
                        ? {
                              ...p,
                              intent: "intended" as const,
                              intendedChange: [change],
                          }
                        : p,
                ),
            },
            [],
        );
        expect(byDiff[0]).toMatchObject({
            intended: true,
            intendedBy: "diff",
            intendedChange: [change],
        });
        const [regression, byTest] = buildFindings(run, []);
        expect(regression).not.toHaveProperty("intendedBy");
        expect(byTest).toMatchObject({ intended: true, intendedBy: "test" });
        expect(byTest).not.toHaveProperty("intendedChange");
    });

    it("without stream steps, says what it knows and no more", () => {
        const [f] = buildFindings(regressionRun(), []);
        expect(f.base.answer).toBe("not recorded");
        expect(f.base.steady).toBe(false);
        expect(f.change).toBe("status, json.error differ");
        expect(f.evidenceKind).toBe("unknown");
    });

    it("tells an exec probe from an HTTP one, for the evidence block", () => {
        const side = (exitCode: number) => ({
            side: "pr" as const,
            sha: "x",
            answer: `exit ${exitCode}`,
            steady: true,
            rounds: [
                {
                    stepId: "s",
                    round: 1,
                    answer: `exit ${exitCode}`,
                    exitCode,
                    lost: false,
                },
            ],
        });
        expect(evidenceKindOf([side(0), side(1)])).toBe("exec");
        expect(changeLine({ ...side(0), side: "base" }, side(1), [])).toBe(
            "exit 0 → exit 1",
        );
    });
});

describe("requestLine", () => {
    it("says what was sent, never a body or a query", () => {
        const { requestLine } = jest.requireActual("./findings");
        expect(
            requestLine({
                kind: "http",
                method: "POST",
                service: "web",
                port: 3000,
                path: "/orders",
                purpose: "p",
                expected: "201",
            }),
        ).toBe("POST web:3000/orders");
        expect(
            requestLine({
                kind: "browser",
                path: "/cart",
                purpose: "p",
                expected: "e",
            }),
        ).toBe("browser /cart");
        expect(
            requestLine({
                kind: "sql",
                service: "db",
                port: 5432,
                purpose: "p",
                expected: "e",
            }),
        ).toBe("SQL query on db:5432");
    });
});

describe("review suggestion and intended mark", () => {
    it("links the Kodus PR page on the suggestion, only with an id the product could have written", () => {
        expect(reviewSuggestionHref("repo 1", 7, "sugg-1")).toBe(
            "/pull-requests/repo%201/7?suggestion=sugg-1",
        );
        expect(reviewSuggestionHref("repo-1", 7, "../x")).toBeUndefined();
        expect(reviewSuggestionHref(undefined, 7, "sugg-1")).toBeUndefined();
        expect(reviewSuggestionHref("repo-1", 7, undefined)).toBeUndefined();
    });

    it("carries the suggestion link and the developer's mark to the finding", () => {
        const run = regressionRun();
        const [f] = buildFindings(
            {
                ...run,
                probes: run.probes?.map((p) => ({
                    ...p,
                    suggestionId: "sugg-1",
                })),
                findings: run.findings?.map((p) => ({
                    ...p,
                    suggestionId: "sugg-1",
                })),
                intendedBy: {
                    "orders-coupon": {
                        userId: "u-1",
                        at: "2026-11-06T18:00:00.000Z",
                        mine: false,
                    },
                },
            },
            [],
        );
        expect(f.reviewHref).toContain("?suggestion=sugg-1");
        expect(f.markedIntended).toEqual({
            mine: false,
            at: "2026-11-06T18:00:00.000Z",
        });
        expect(buildFindings(run, [])[0].reviewHref).toBeUndefined();
    });

    it("keeps the cache in step with what PUT …/intent answered", () => {
        const marked = withIntentResult({ intendedBy: {} }, "p1", {
            intended: true,
            userId: "u-1",
            at: "2026-11-06T18:00:00.000Z",
            mine: true,
        });
        expect(marked.intendedBy).toEqual({
            p1: { userId: "u-1", at: "2026-11-06T18:00:00.000Z", mine: true },
        });
        expect(
            withIntentResult(marked, "p1", { intended: false }).intendedBy,
        ).toEqual({});
    });
});

describe("evidence fields", () => {
    it("carries the lanes, the response diff and the code ref when the verdict has them", () => {
        const [f] = buildFindings(
            healthRegressionRun(),
            healthRegressionView().steps,
        );
        expect(f.route).toBe("GET /api/health");
        expect(f.lanes?.firstDifference?.kind).toBe("log");
        expect(f.responseDiff?.fields).toHaveLength(2);
        expect(f.diffRef).toEqual({ file: "pkg/api/health.go", line: 23 });
    });

    it("leaves them out on an older Run, and names an outside probe by what it sent", () => {
        const [f] = buildFindings(
            regressionRun({
                probes: [
                    {
                        probeId: "x",
                        entryPoint: "unmapped",
                        exercised: "GET /api/health",
                        verdict: "finding",
                        reason: "differs",
                    },
                ],
            }),
            [],
        );
        expect(f.route).toBe("GET /api/health");
        expect(f).not.toHaveProperty("lanes");
        expect(f).not.toHaveProperty("responseDiff");
        expect(f).not.toHaveProperty("diffRef");
    });
});

describe("a boot finding", () => {
    it("is marked boot and says main booted, not that an answer differs", () => {
        const [f] = buildFindings(bootRegressionRun(), []);
        expect(f).toMatchObject({
            boot: true,
            destabilizes: true,
            change: "main booted · this PR did not boot",
        });
        const [other] = buildFindings(healthRegressionRun(), []);
        expect(other.boot).toBe(false);
    });
});

describe("a finding that matches what the PR expected", () => {
    const finding = (patch: Parameters<typeof newRouteRun>[0] = {}) =>
        buildFindings(newRouteRun(patch), newRouteView().steps)[0];

    it("is flagged when this PR answers the status expected before running and main has no such route", () => {
        expect(finding().matchesExpectation).toBe(true);
    });

    it("is not flagged when the expectation is prose, the answers differ from it, or main answered an error of its own", () => {
        const requests = newRouteRun().probeRequests!;
        const withExpected = (expected: string) => ({
            probeRequests: {
                "orders-export": { ...requests["orders-export"], expected },
            },
        });
        expect(
            finding(withExpected("200 with the CSV of the orders"))
                .matchesExpectation,
        ).toBeUndefined();
        expect(finding(withExpected("201")).matchesExpectation).toBeUndefined();
        const steps = newRouteView().steps.map((s) =>
            s.status === 404 ? { ...s, status: 500 } : s,
        );
        expect(
            buildFindings(newRouteRun(), steps)[0].matchesExpectation,
        ).toBeUndefined();
        expect(
            buildFindings(regressionRun(), regressionView().steps)[0]
                .matchesExpectation,
        ).toBeUndefined();
    });

    it("comes after a real regression and before an intended change", () => {
        const regression = regressionRun().probes!;
        const run = newRouteRun({
            probes: [...newRouteRun().probes!, ...regression],
        });
        const order = buildFindings(run, [
            ...newRouteView().steps,
            ...regressionView().steps,
        ]).map((f) => f.probeId);
        expect(order).toEqual([
            "orders-coupon",
            "orders-export",
            "order-detail",
        ]);
    });
});
