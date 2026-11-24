import type { EXERCISED_LANGUAGES, ExercisedResult } from '@libs/runtime/protocol/messages';

export type ExercisedLanguage = (typeof EXERCISED_LANGUAGES)[number];

// Which of the PR's changed lines ran during the probes, as the cell counted
// them (protocol claim.exercised). Files the cell could not measure count in
// neither total. Read by decideRunVerdict (run-state.ts): a green Run whose
// measured share is below the threshold stays partly tested. It never upgrades
// a verdict and never changes another one.

export interface ExercisedSummary {
    exercised: number;
    changed: number;
    /**
     * The share that must run, 0 to 1: the org's Runtime setting the Run started with
     * (RuntimeRunRequested.exercisedLinesThresholdPercent / 100), else the worker's
     * RUNTIME_EXERCISED_LINES_THRESHOLD_PERCENT / 100. 0 never holds a Run back.
     */
    threshold: number;
    /** Absent when the cell did not answer (no exercisedLines feature, or no answer). */
    language?: ExercisedLanguage;
    /** At least one file was measured, and some of the changed lines were attributed to the source. */
    measured: boolean;
    /** Why it is not measured when the changed files' coverage could not be attributed to source (no mapping). */
    reason?: 'no_source_map';
}

/** Reasons a changed file's coverage could not be attributed to its source. */
const UNATTRIBUTED: ReadonlySet<string> = new Set(['not_loaded_unproven', 'unmapped_source']);

/** The measured files summed; `result` absent means the cell gave no answer. */
export function exercisedSummaryOf(result: Pick<ExercisedResult, 'language' | 'files'> | undefined, threshold: number): ExercisedSummary {
    if (!result) return { exercised: 0, changed: 0, threshold, measured: false };
    const files = result.files.filter((f) => f.status === 'measured' && f.exercisedLines !== null);
    const changed = files.reduce((n, f) => n + f.changedLines, 0);
    const exercised = files.reduce((n, f) => n + Math.min(f.exercisedLines ?? 0, f.changedLines), 0);
    // A file the cell could not map, and nothing attributed to any other: a production build with no source maps
    // ran the changed code, but "0 of N" would say it did not. Not measured. A real 0 (every file mapped) still shows.
    const unattributed = result.files.some((f) => f.status === 'unknown' && f.reason !== undefined && UNATTRIBUTED.has(f.reason));
    if (unattributed && exercised === 0) return { exercised: 0, changed: 0, threshold, language: result.language, measured: false, reason: 'no_source_map' };
    return { exercised, changed, threshold, language: result.language, measured: files.length > 0 };
}

/** The threshold as the reader sees it: a whole percent. */
export const exercisedThresholdPercent = (s: Pick<ExercisedSummary, 'threshold'>): number => Math.round(s.threshold * 100);

/**
 * "N of M changed lines ran, below the T% this repo asks" when fewer than the
 * threshold of the measured changed lines ran; else undefined.
 */
export function exercisedShortfall(s: ExercisedSummary | undefined): string | undefined {
    if (!s?.measured || s.changed === 0 || s.exercised / s.changed >= s.threshold) return undefined;
    return `${s.exercised} of ${s.changed} changed lines ran, below the ${exercisedThresholdPercent(s)}% this repo asks`;
}

/** The fact the verdict card and the PR comment show; undefined when the Run has no summary. */
export function exercisedFact(s: ExercisedSummary | undefined): string | undefined {
    if (!s) return undefined;
    if (s.measured) return `Changed lines exercised: ${s.exercised} of ${s.changed}`;
    if (s.reason === 'no_source_map') return 'Changed lines exercised: not measurable for a bundled build without source maps';
    return s.language ? `Changed lines exercised: not measured for ${s.language}` : 'Changed lines exercised: not measured';
}
