/**
 * GitHub quota burn curve.
 *
 * Per-scenario deltas were the first instrument (see runner.ts), and they were
 * not enough. The onboarding backfill is dispatched in the background and
 * detached from the request that triggers it, so its spend lands wherever it
 * happens to land: run 31512568881 charged 422 requests to `code-review-basic`,
 * a scenario that does almost no GitHub work, because the PREVIOUS scenario's
 * backfill was still running. Any measurement aligned to scenario boundaries
 * smears asynchronous work across whatever was in the foreground.
 *
 * Sampling on a timer instead of on boundaries shows the shape: when a burn
 * starts, how long it lasts, how fast it goes, and whether it was still going
 * when the run ended. /rate_limit does not count against the quota it reports,
 * so the sampling is free.
 */

export interface QuotaSample {
    atMs: number;
    remaining: number;
}

/** What the harness was doing when a sample was taken. */
export interface QuotaMark {
    atMs: number;
    /** Scenario id, or IDLE between scenarios. */
    label: string;
}

export const IDLE = 'idle';

export interface BurnWindow {
    startMs: number;
    endMs: number;
    spent: number;
    /** Requests per minute across the window — the shape, not just the size. */
    ratePerMin: number;
    /** The harness activity this window is attributed to. */
    during: string;
}

export interface QuotaCurveSummary {
    totalSpent: number;
    /** True when the last sample was still dropping — the burn outlived the run. */
    truncated: boolean;
    windows: BurnWindow[];
}

/**
 * Fold samples into contiguous windows of a single activity.
 *
 * A rising `remaining` is GitHub's hourly window resetting, not negative
 * spend; those intervals contribute nothing rather than a bogus credit.
 */
export function summarizeQuotaCurve(
    samples: QuotaSample[],
    marks: QuotaMark[] = [],
): QuotaCurveSummary {
    const ordered = [...(samples ?? [])].sort((a, b) => a.atMs - b.atMs);
    if (ordered.length < 2) {
        return { totalSpent: 0, truncated: false, windows: [] };
    }

    const sortedMarks = [...(marks ?? [])].sort((a, b) => a.atMs - b.atMs);
    const activityAt = (atMs: number): string => {
        let current = IDLE;
        for (const mark of sortedMarks) {
            if (mark.atMs > atMs) break;
            current = mark.label;
        }
        return current;
    };

    const windows: BurnWindow[] = [];
    let totalSpent = 0;

    for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1];
        const cur = ordered[i];
        const spent = prev.remaining - cur.remaining;
        if (spent <= 0) {
            continue;
        }
        totalSpent += spent;

        const during = activityAt(prev.atMs);
        const last = windows[windows.length - 1];
        // Merge only when the same activity ran without interruption, so a
        // scenario that burns, pauses and burns again reads as one window
        // rather than a misleading average.
        if (last && last.during === during && last.endMs === prev.atMs) {
            last.endMs = cur.atMs;
            last.spent += spent;
        } else {
            windows.push({
                startMs: prev.atMs,
                endMs: cur.atMs,
                spent,
                ratePerMin: 0,
                during,
            });
        }
    }

    for (const w of windows) {
        const minutes = (w.endMs - w.startMs) / 60_000;
        w.ratePerMin = minutes > 0 ? Math.round(w.spent / minutes) : w.spent;
    }
    windows.sort((a, b) => b.spent - a.spent);

    // Still dropping at the last sample: whatever was burning did not finish
    // inside the run, so `totalSpent` is a floor, not a total.
    const lastSpent =
        ordered[ordered.length - 2].remaining -
        ordered[ordered.length - 1].remaining;

    return { totalSpent, truncated: lastSpent > 0, windows };
}

export function describeQuotaCurve(summary: QuotaCurveSummary): string[] {
    if (!summary.windows.length) {
        return ['[quota-curve] no GitHub spend observed'];
    }
    const lines = [
        `[quota-curve] ${summary.totalSpent} requests observed${summary.truncated ? ' (still burning at the last sample — this is a floor)' : ''}`,
    ];
    for (const w of summary.windows.slice(0, 3)) {
        const secs = Math.round((w.endMs - w.startMs) / 1000);
        lines.push(
            `[quota-curve]   ${w.spent} requests over ${secs}s (${w.ratePerMin}/min) during ${w.during}`,
        );
    }
    return lines;
}

export interface QuotaSampler {
    mark(label: string): void;
    stop(): QuotaCurveSummary;
    samples: QuotaSample[];
    marks: QuotaMark[];
}

/**
 * Poll `probe` on a timer until stopped. A failed probe is skipped rather than
 * recorded: a network blip must not read as "the quota did not move".
 */
export function startQuotaSampler(opts: {
    probe: () => Promise<{ remaining: number } | undefined>;
    intervalMs?: number;
    now?: () => number;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
}): QuotaSampler {
    const now = opts.now ?? Date.now;
    const setIntervalImpl = opts.setIntervalFn ?? setInterval;
    const clearIntervalImpl = opts.clearIntervalFn ?? clearInterval;
    const samples: QuotaSample[] = [];
    const marks: QuotaMark[] = [];

    const tick = async () => {
        try {
            const quota = await opts.probe();
            if (quota) {
                samples.push({ atMs: now(), remaining: quota.remaining });
            }
        } catch {
            // Deliberately silent: the sampler is an observer and must never
            // be the reason a run fails.
        }
    };

    void tick();
    const handle = setIntervalImpl(() => void tick(), opts.intervalMs ?? 15_000);
    handle.unref?.();

    return {
        samples,
        marks,
        mark(label: string) {
            marks.push({ atMs: now(), label });
        },
        stop() {
            clearIntervalImpl(handle);
            return summarizeQuotaCurve(samples, marks);
        },
    };
}
