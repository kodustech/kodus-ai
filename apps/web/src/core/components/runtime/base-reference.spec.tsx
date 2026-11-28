/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { forwardRef, type ReactNode } from "react";
import {
    healthRegressionRun,
    healthRegressionView,
    partlyTestedRun,
    partlyTestedView,
} from "@services/runtime/model/__fixtures__/run-detail";
import { buildFindings } from "@services/runtime/model/findings";
import { whatHappened } from "@services/runtime/model/what-happened";
import { coverageRows } from "@services/runtime/model/coverage";
import { buildRunPaths } from "@services/runtime/model/run-paths";
import { runTiming } from "@services/runtime/model/run-timing";
import { plainText } from "@services/runtime/model/rich-text";
import { render, screen, fireEvent } from "@testing-library/react";
import { RunFindingsView } from "./run-findings";
import { RunTimingView } from "./run-timing";
import { RunCoverageList } from "./run-coverage";

jest.mock("@services/runtime/queries", () => ({
    useFindingFeedback: jest.fn(),
    useRunReproduction: () => ({ isPending: true }),
}));
jest.mock("./evidence-link", () => ({
    EvidenceLink: ({ children }: { children: ReactNode }) => (
        <button type="button">{children}</button>
    ),
}));
jest.mock("./evidence-media", () => ({
    EvidenceImage: ({ alt }: { alt: string }) => <img alt={alt} />,
    EvidenceVideo: forwardRef<HTMLVideoElement, { label: string }>(
        ({ label }, ref) => <video aria-label={label} ref={ref} />,
    ),
}));

describe.each(["release/2026", undefined])(
    "recorded base reference (%j)",
    (baseBranch) => {
        const label = baseBranch || "base version";
        it("keeps the recorded reference in findings, response columns, replay and the structured story", () => {
            const run = healthRegressionRun({ baseBranch });
            const findings = buildFindings(run, healthRegressionView().steps);
            expect(findings[0].proof).toContain(`on ${label}`);
            expect(
                whatHappened(findings[0]).map(plainText).join(" "),
            ).toContain(`on ${label}`);
            render(<RunFindingsView runId={run.runId} findings={findings} />);
            expect(
                screen.getByRole("columnheader", { name: label }),
            ).toBeInTheDocument();
            expect(
                screen.getByRole("region", {
                    name: `Replay of GET /api/health on ${label} and this PR`,
                }),
            ).toBeInTheDocument();
            expect(
                screen.queryByRole("columnheader", { name: /^main$/ }),
            ).not.toBeInTheDocument();
        });
        it("uses the same reference in timing labels and base build details", () => {
            const original = partlyTestedRun();
            const run = partlyTestedRun({
                baseBranch,
                buildSteps: [
                    { ...original.buildSteps![0], side: "base" },
                    ...original.buildSteps!,
                ],
            });
            const timing = runTiming(run, partlyTestedView());
            expect(timing.phases.find((p) => p.id === "boot")?.label).toBe(
                `Boot ${label}`,
            );
            render(<RunTimingView timing={timing} />);
            expect(
                screen.getByText(new RegExp(`Build of ${label}:`)),
            ).toBeInTheDocument();
        });
        it("names the reference for matching failures, inconclusive coverage and its evidence", () => {
            const original = partlyTestedRun();
            const run = partlyTestedRun({
                baseBranch,
                probes: [{ ...original.probes![0], verdict: "pre_existing" }],
            });
            const rows = coverageRows(
                buildRunPaths(run, partlyTestedView().steps),
                run,
            );
            expect(plainText(rows[0].detail)).toContain(
                `fails the same way on ${label}`,
            );
            const inconclusive = partlyTestedRun({
                ...run,
                probes: [{ ...run.probes![0], verdict: "inconclusive" }],
            });
            const unknown = coverageRows(
                buildRunPaths(inconclusive, []),
                inconclusive,
            );
            expect(plainText(unknown[0].detail)).toContain(
                `${label} answered differently between attempts`,
            );
            render(<RunCoverageList runId={run.runId} rows={rows} />);
            fireEvent.click(
                screen.getByRole("button", {
                    name: "Show evidence for GET /api/health",
                }),
            );
            expect(screen.getByText(`${label} · round 1`)).toBeInTheDocument();
        });
    },
);
