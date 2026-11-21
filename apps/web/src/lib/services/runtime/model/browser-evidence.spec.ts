import { browserLanes } from "./__fixtures__/browser-lanes";
import {
    buildBrowserEvidence,
    formatChanged,
    hasBrowserEvidence,
    initialPair,
    stepAt,
} from "./browser-evidence";

describe("browser evidence (ADR-071)", () => {
    it("lines the steps up as chips and marks where main and this PR part", () => {
        const view = buildBrowserEvidence(browserLanes())!;
        expect(
            view.chips.map((c) => [c.label, c.base, c.pr, c.differs]),
        ).toEqual([
            ["goto /", "passed", "passed", false],
            ["waitFor body[data-state=ready]", "passed", "passed", false],
            ["screenshot orders", "passed", "passed", false],
            ['expectText #orders "keyboard"', "passed", "failed", true],
        ]);
        const last = view.chips[3];
        expect(last).toMatchObject({
            first: true,
            why: "text did not match",
            values: { base: "keyboard × 2\nmonitor × 1", pr: "" },
        });
    });

    it("pairs the screenshots of the same step, with this PR's pixel diff, and starts on the first difference", () => {
        const view = buildBrowserEvidence(browserLanes())!;
        expect(view.pairs).toEqual([
            {
                step: 2,
                label: "screenshot orders",
                base: "screenshot-0",
                pr: "screenshot-0",
                pixeldiff: "pixeldiff-0",
                ratio: 0.0412,
                changed: "4.1 % of pixels changed",
            },
            {
                step: 3,
                label: 'expectText #orders "keyboard"',
                pr: "screenshot-1",
            },
        ]);
        expect(initialPair(view)).toBe(1);
    });

    it("puts each side's steps on its own video's clock", () => {
        const view = buildBrowserEvidence(browserLanes())!;
        expect(view.video.base.marks[0]).toEqual({ index: 0, at: 0.01 });
        expect(view.video.pr.marks[3]).toEqual({ index: 3, at: 1.09 });
        expect(stepAt(view.video.pr.marks, 0.9)).toBe(2);
        expect(stepAt(view.video.pr.marks, 5)).toBe(3);
        expect(view.downloads.pr).toEqual({
            stepId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
            trace: true,
            har: true,
        });
    });

    it("is absent for a probe that is not a browser one", () => {
        const lanes = browserLanes();
        delete lanes.pr.browser;
        expect(hasBrowserEvidence(lanes)).toBe(false);
        expect(buildBrowserEvidence(lanes)).toBeUndefined();
        expect(hasBrowserEvidence(undefined)).toBe(false);
    });

    it("says how much changed, never 0 % for a few pixels", () => {
        expect(formatChanged(0.0412)).toBe("4.1 % of pixels changed");
        expect(formatChanged(0.0004)).toBe("< 0.1 % of pixels changed");
        expect(formatChanged(0)).toBe("0.0 % of pixels changed");
        expect(formatChanged(0.5)).toBe("50 % of pixels changed");
    });
});
