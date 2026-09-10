import {
    MAX_PATCH_CHARS_PER_FILE,
    MAX_TOTAL_EMBEDDED_PATCH_CHARS,
    TRUNCATED_DIFF_MARKER,
    budgetPatchForPersist,
    clampPatchForPersist,
} from './diff-budget';

describe('diff-budget (#1841)', () => {
    describe('budgetPatchForPersist', () => {
        it('passes a patch that fits the per-file cap through unchanged', () => {
            const patch = 'x'.repeat(1000);
            const result = budgetPatchForPersist(
                patch,
                MAX_TOTAL_EMBEDDED_PATCH_CHARS,
            );
            expect(result.patch).toBe(patch);
            expect(result.truncated).toBe(false);
            expect(result.consumed).toBe(1000);
        });

        it('passes through an empty patch with zero cost', () => {
            const result = budgetPatchForPersist('', 100);
            expect(result.patch).toBe('');
            expect(result.truncated).toBe(false);
            expect(result.consumed).toBe(0);
        });

        it('truncates a patch that exceeds the per-file cap, keeping a leading window plus the marker', () => {
            const patch = 'h'.repeat(MAX_PATCH_CHARS_PER_FILE + 50_000);
            const result = budgetPatchForPersist(
                patch,
                MAX_TOTAL_EMBEDDED_PATCH_CHARS,
            );
            expect(result.truncated).toBe(true);
            expect(result.patch.length).toBeLessThanOrEqual(
                MAX_PATCH_CHARS_PER_FILE,
            );
            // the marker is present and the leading bytes survived
            expect(result.patch.endsWith(TRUNCATED_DIFF_MARKER)).toBe(true);
            expect(result.patch.startsWith('h'.repeat(100))).toBe(true);
            expect(result.consumed).toBe(result.patch.length);
        });

        it('respects a tight remaining aggregate budget even for one patch', () => {
            const patch = 'z'.repeat(10_000);
            const remaining = 2000;
            const result = budgetPatchForPersist(patch, remaining);
            expect(result.truncated).toBe(true);
            expect(result.patch.length).toBeLessThanOrEqual(remaining);
        });

        it('drops the diff when even the marker no longer fits the remaining budget', () => {
            const patch = 'z'.repeat(10_000);
            const result = budgetPatchForPersist(patch, 10);
            expect(result).toEqual({
                patch: '',
                truncated: true,
                consumed: 0,
            });
        });

        it('drops the diff when the aggregate budget is already exhausted', () => {
            const result = budgetPatchForPersist('z'.repeat(100), 0);
            expect(result).toEqual({
                patch: '',
                truncated: true,
                consumed: 0,
            });
        });

        it('keeps the cumulative consumed sum within the aggregate budget', () => {
            const big = 'a'.repeat(300_000); // > per-file cap
            const r1 = budgetPatchForPersist(big, 500_000);
            expect(r1.truncated).toBe(true);
            const r2 = budgetPatchForPersist('b'.repeat(500_000), 500_000 - r1.consumed);
            expect(r2.truncated).toBe(true);
            expect(r1.consumed + r2.consumed).toBeLessThanOrEqual(500_000);
        });
    });

    describe('clampPatchForPersist', () => {
        it('passes a small patch through unchanged', () => {
            const patch = 'y'.repeat(MAX_PATCH_CHARS_PER_FILE - 1);
            expect(clampPatchForPersist(patch)).toBe(patch);
        });

        it('truncates an oversized patch and appends the marker', () => {
            const clamped = clampPatchForPersist('y'.repeat(MAX_PATCH_CHARS_PER_FILE * 2));
            expect(clamped.length).toBeLessThanOrEqual(MAX_PATCH_CHARS_PER_FILE);
            expect(clamped.endsWith(TRUNCATED_DIFF_MARKER)).toBe(true);
        });
    });
});