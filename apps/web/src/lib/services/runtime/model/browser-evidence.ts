import type {
    BrowserLane,
    BrowserLaneStep,
    ReplayLanes,
} from "@libs/runtime/run/replay-lanes";

import type { EvidenceType } from "../contracts";

// A browser finding on the Run page (ADR-071): the steps main and this PR
// played, the screenshots of the same step side by side with the pixel
// diff, the two recordings on the steps' timeline, and the page's console
// and network. Built from the verdict's lanes only: the screen shows the
// gate's decision, it never makes one. Every image, video and download is
// opened by a signed URL on the isolated evidence origin.

export type { BrowserLane, BrowserLaneStep };

export type StepOutcome = "passed" | "failed" | "skipped" | "absent";

export type BrowserStepChip = {
    index: number;
    label: string;
    base: StepOutcome;
    pr: StepOutcome;
    /** The two sides part here (outcome or what the step read). */
    differs: boolean;
    /** The first step that differs. */
    first: boolean;
    /** What each side read (expectText, getAttribute), when it differs. */
    values?: { base?: string; pr?: string };
    /** Why this PR's step failed ("text did not match"). */
    why?: string;
};

export type ScreenshotPair = {
    /** The step that took both. */
    step: number;
    label: string;
    base?: EvidenceType;
    pr?: EvidenceType;
    pixeldiff?: EvidenceType;
    /** "4.1 % of pixels changed"; absent when the cell did not measure it. */
    changed?: string;
    ratio?: number;
};

export type VideoSide = {
    stepId: string;
    available: boolean;
    /** Where each step starts in this side's video, in seconds. */
    marks: Array<{ index: number; at: number }>;
};

export type BrowserEvidenceView = {
    chips: BrowserStepChip[];
    pairs: ScreenshotPair[];
    video: { base: VideoSide; pr: VideoSide };
    console: { base: BrowserLane["console"]; pr: BrowserLane["console"] };
    network: { base: BrowserLane["network"]; pr: BrowserLane["network"] };
    downloads: {
        base: { stepId: string; trace: boolean; har: boolean };
        pr: { stepId: string; trace: boolean; har: boolean };
    };
    truncated: boolean;
};

const WHY: Record<string, string> = {
    timeout: "timed out",
    not_found: "element not found",
    mismatch: "text did not match",
    navigation: "page did not load",
    refused: "step refused",
    skipped: "skipped after an earlier failure",
    error: "failed",
};

export const stepWhy = (error: string | undefined): string | undefined =>
    error ? (WHY[error] ?? "failed") : undefined;

const outcomeOf = (s: BrowserLaneStep | undefined): StepOutcome =>
    !s
        ? "absent"
        : s.ok
          ? "passed"
          : s.error === "skipped"
            ? "skipped"
            : "failed";

/** "4.1 % of pixels changed", "< 0.1 % of pixels changed". */
export const formatChanged = (ratio: number): string => {
    const pct = ratio * 100;
    if (pct > 0 && pct < 0.1) return "< 0.1 % of pixels changed";
    return `${pct.toFixed(pct < 10 ? 1 : 0)} % of pixels changed`;
};

/** Both sides played a browser probe this cell recorded. */
export const hasBrowserEvidence = (lanes: ReplayLanes | undefined): boolean =>
    !!lanes?.base?.browser?.steps?.length &&
    !!lanes?.pr?.browser?.steps?.length;

const has = (lane: ReplayLanes["base"], type: string) =>
    (lane.artifacts ?? []).some((a) => a.type === type);

const marksOf = (b: BrowserLane) =>
    b.steps.map((s) => ({
        index: s.index,
        at: Math.max(0, (s.startMs - (b.videoStartMs ?? 0)) / 1000),
    }));

export const buildBrowserEvidence = (
    lanes: ReplayLanes,
): BrowserEvidenceView | undefined => {
    if (!hasBrowserEvidence(lanes)) return undefined;
    const base = lanes.base.browser!;
    const pr = lanes.pr.browser!;
    const count = Math.max(base.steps.length, pr.steps.length);
    const chips: BrowserStepChip[] = [];
    for (let i = 0; i < count; i++) {
        const a = base.steps[i];
        const b = pr.steps[i];
        const differs =
            outcomeOf(a) !== outcomeOf(b) ||
            (a?.value ?? "") !== (b?.value ?? "");
        const valuesDiffer =
            (a?.value !== undefined || b?.value !== undefined) &&
            a?.value !== b?.value;
        chips.push({
            index: i,
            label: (b ?? a)!.label,
            base: outcomeOf(a),
            pr: outcomeOf(b),
            differs,
            first: lanes.firstStepDifference === i,
            ...(valuesDiffer
                ? {
                      values: {
                          ...(a?.value !== undefined ? { base: a.value } : {}),
                          ...(b?.value !== undefined ? { pr: b.value } : {}),
                      },
                  }
                : {}),
            ...(b && !b.ok ? { why: stepWhy(b.error) } : {}),
        });
    }
    // The same step on both sides; a failing step's shot on one side only is still shown.
    const pairs: ScreenshotPair[] = [];
    for (let i = 0; i < count; i++) {
        const a = base.steps[i];
        const b = pr.steps[i];
        if (!a?.screenshot && !b?.screenshot) continue;
        pairs.push({
            step: i,
            label: (b ?? a)!.label,
            ...(a?.screenshot ? { base: a.screenshot } : {}),
            ...(b?.screenshot ? { pr: b.screenshot } : {}),
            ...(b?.pixeldiff ? { pixeldiff: b.pixeldiff } : {}),
            ...(b?.ratio !== undefined
                ? { ratio: b.ratio, changed: formatChanged(b.ratio) }
                : {}),
        });
    }
    return {
        chips,
        pairs,
        video: {
            base: {
                stepId: lanes.base.stepId,
                available: has(lanes.base, "video"),
                marks: marksOf(base),
            },
            pr: {
                stepId: lanes.pr.stepId,
                available: has(lanes.pr, "video"),
                marks: marksOf(pr),
            },
        },
        console: { base: base.console, pr: pr.console },
        network: { base: base.network, pr: pr.network },
        downloads: {
            base: {
                stepId: lanes.base.stepId,
                trace: has(lanes.base, "trace"),
                har: has(lanes.base, "har"),
            },
            pr: {
                stepId: lanes.pr.stepId,
                trace: has(lanes.pr, "trace"),
                har: has(lanes.pr, "har"),
            },
        },
        truncated: base.truncated || pr.truncated,
    };
};

/** The pair to show first: the first difference's, else the first that changed, else the first. */
export const initialPair = (view: BrowserEvidenceView): number => {
    const first = view.chips.find((c) => c.first)?.index;
    const at =
        first === undefined
            ? -1
            : view.pairs.findIndex((p) => p.step === first);
    if (at >= 0) return at;
    const changed = view.pairs.findIndex((p) => (p.ratio ?? 0) > 0);
    return changed >= 0 ? changed : 0;
};

/** The step a video is at: the last whose mark it passed. */
export const stepAt = (marks: VideoSide["marks"], seconds: number): number => {
    let at = marks[0]?.index ?? 0;
    for (const m of marks) if (m.at <= seconds + 0.001) at = m.index;
    return at;
};
