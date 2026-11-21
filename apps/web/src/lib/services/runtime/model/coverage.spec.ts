import {
    partlyTestedRun,
    partlyTestedView,
    regressionRun,
    regressionView,
} from "./__fixtures__/run-detail";
import { coverageRows, untestedReason } from "./coverage";
import { plainText } from "./rich-text";
import { buildRunPaths } from "./run-paths";

const rowsOf = (
    run: ReturnType<typeof regressionRun>,
    steps = regressionView().steps,
) => coverageRows(buildRunPaths(run, steps), run);

describe("coverageRows", () => {
    it("explains a recorded pre-existing-only cause without claiming no request ran", () => {
        const reason = untestedReason(
            { entryPoint: "GET /cart", reason: "pre_existing" },
            "env-1",
        );
        expect(plainText(reason.detail)).toContain(
            "The same failure was observed on both versions",
        );
        expect(plainText(reason.detail)).not.toContain("No check reached");
    });

    it("labels every path plainly, regressions first", () => {
        const rows = rowsOf(regressionRun());
        expect(rows.map((r) => [r.entryPoint, r.label])).toEqual([
            ["POST /orders", "Regression"],
            ["GET /orders/:id", "Changed, as the PR intends"],
            ["GET /cart", "Same on both versions"],
            ["POST /payments", "Not tested"],
        ]);
        expect(plainText(rows[2].detail)).toBe("200 on main · 200 on this PR");
        expect(plainText(rows[1].detail)).toBe(
            "Differs in json.total_before_tax",
        );
    });

    it("a member the recipe does not boot says so, and how to boot it", () => {
        const { detail, action } = untestedReason(
            {
                entryPoint: "POST /invoices/preview",
                reason: "blocker",
                blocker: { kind: "other_repo", alias: "billing" },
            },
            "env-1",
        );
        expect(plainText(detail)).toBe(
            "The setup file does not boot billing. Add it to services.needs in .kodus/workspace.yaml on the default branch.",
        );
        expect(action).toEqual({
            href: "/runtime/environments/env-1",
            label: "Open the environment",
        });
    });

    it("names the missing variable and links to where it is added", () => {
        const payments = rowsOf(regressionRun()).at(-1)!;
        expect(plainText(payments.detail)).toBe(
            "Needs STRIPE_TEST_KEY, which this environment does not have.",
        );
        expect(payments.action).toEqual({
            href: "/runtime/environments/env-1",
            label: "Add STRIPE_TEST_KEY",
        });
        expect(payments.path).toBeUndefined();
    });

    it("a path that failed the same way on main reads as the same, not as 'already on main'", () => {
        const run = partlyTestedRun({
            probes: [
                { ...partlyTestedRun().probes![0], verdict: "pre_existing" },
            ],
        });
        const [row] = coverageRows(
            buildRunPaths(run, partlyTestedView().steps),
            run,
        );
        expect(row.label).toBe("Same on both versions, not as expected");
        expect(row.mark).toBe("same");
        expect(plainText(row.detail)).toContain("fails the same way on main");
    });

    it("without the report's reasons, an untested entry point says no probe reached it", () => {
        const run = partlyTestedRun();
        const rows = coverageRows(
            buildRunPaths(run, partlyTestedView().steps),
            run,
        );
        expect(rows.at(-1)).toMatchObject({
            entryPoint: "pkg/main.go",
            label: "Not tested",
        });
        expect(plainText(rows.at(-1)!.detail)).toBe("No check reached it.");
    });

    it("an undecided probe says why by its verdict", () => {
        const run = partlyTestedRun({
            probes: [
                { ...partlyTestedRun().probes![0], verdict: "inconclusive" },
            ],
        });
        const [row] = coverageRows(buildRunPaths(run, []), run);
        expect(row.mark).toBe("untested");
        expect(plainText(row.detail)).toMatch(/differently between attempts/);
    });

    it("another blocker kind links to the environment", () => {
        expect(
            untestedReason(
                {
                    entryPoint: "x",
                    reason: "blocker",
                    blocker: { kind: "external_service" },
                },
                "env 1",
            ),
        ).toEqual({
            detail: ["Blocked: external service."],
            action: {
                href: "/runtime/environments/env%201",
                label: "Open the environment",
            },
        });
    });
});
