import {
    extractValidDiffLines,
    snapLinesToDiff,
} from './agent-review.stage';

/**
 * Regression tests for the diff-boundary guard (problem #1: "suggests changes
 * on unchanged code"). A finding whose cited lines fall entirely outside the
 * PR's changed hunks must be DROPPED (snapLinesToDiff -> null), not clamped
 * onto an unrelated changed line.
 */
describe('agent-review diff-boundary guard', () => {
    // A patch that adds two `lastSyncedAt` lines (right-side lines ~32 and ~55),
    // mirroring the reproduction. Everything else is context (unchanged).
    const patch = [
        '@@ -29,4 +29,5 @@ export interface LocalStores {',
        ' \tpendingClashes?: string[]',
        '+\tlastSyncedAt?: number',
        ' }',
        ' ',
        '@@ -51,4 +52,5 @@ export function parseLocalStore() {',
        ' \t\tlastFetchedRemoteSha: undefined,',
        ' \t\tunpushedFiles: {},',
        '+\t\tlastSyncedAt: undefined,',
        ' \t}',
    ].join('\n');

    it('extracts only the changed-hunk right-side ranges', () => {
        const ranges = extractValidDiffLines(patch);
        expect(ranges.length).toBeGreaterThan(0);
        // No range should cover line 40 (untouched code between hunks).
        expect(ranges.some(([s, e]) => 40 >= s && 40 <= e)).toBe(false);
    });

    it('DROPS a finding whose lines are entirely outside any changed hunk', () => {
        const ranges = extractValidDiffLines(patch);
        // Pretend the agent read the full file and flagged a pre-existing
        // rename on line 40 — not part of the diff at all.
        const outOfDiff = {
            relevantFile: 'src/syncStore.ts',
            relevantLinesStart: 40,
            relevantLinesEnd: 41,
            suggestionContent: 'pre-existing rename, not in this PR',
        };
        expect(snapLinesToDiff(outOfDiff, ranges)).toBeNull();
    });

    it('KEEPS and clamps a finding that overlaps a changed hunk', () => {
        const ranges = extractValidDiffLines(patch);
        const overlapping = {
            relevantFile: 'src/syncStore.ts',
            relevantLinesStart: 32,
            relevantLinesEnd: 32,
            suggestionContent: 'about the added lastSyncedAt line',
        };
        const result = snapLinesToDiff(overlapping, ranges);
        expect(result).not.toBeNull();
        expect(result!.relevantLinesStart).toBe(32);
    });

    it('never drops when there are no changed ranges (no-op safety)', () => {
        const s = { relevantLinesStart: 5, relevantLinesEnd: 6 };
        expect(snapLinesToDiff(s, [])).toEqual(s);
    });
});
