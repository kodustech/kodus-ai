import {
    MAX_PATCH_BYTES_PER_FILE,
    MAX_TOTAL_EMBEDDED_PATCH_BYTES,
    TRUNCATED_DIFF_MARKER,
    budgetPatchForPersist,
    clampPatchForPersist,
    clampPatchForPersistWithFlag,
    utf8ByteLength,
} from './diff-budget';

describe('diff-budget (#1841)', () => {
    describe('utf8ByteLength', () => {
        it('counts UTF-8 bytes, not UTF-16 code units', () => {
            expect(utf8ByteLength('abc')).toBe(3);
            // CJK: 3 bytes per char in UTF-8, 1 code unit in UTF-16.
            expect(utf8ByteLength('漢字')).toBe(6);
            // Emoji outside the BMP: 4 bytes, 2 UTF-16 code units.
            expect(utf8ByteLength('😀')).toBe(4);
        });
    });

    describe('budgetPatchForPersist', () => {
        it('passes a patch that fits the per-file cap through unchanged', () => {
            const patch = 'x'.repeat(1000);
            const result = budgetPatchForPersist(
                patch,
                MAX_TOTAL_EMBEDDED_PATCH_BYTES,
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
            const patch = 'h'.repeat(MAX_PATCH_BYTES_PER_FILE + 50_000);
            const result = budgetPatchForPersist(
                patch,
                MAX_TOTAL_EMBEDDED_PATCH_BYTES,
            );
            expect(result.truncated).toBe(true);
            expect(utf8ByteLength(result.patch)).toBeLessThanOrEqual(
                MAX_PATCH_BYTES_PER_FILE,
            );
            // the marker is present and the leading bytes survived
            expect(result.patch.endsWith(TRUNCATED_DIFF_MARKER)).toBe(true);
            expect(result.patch.startsWith('h'.repeat(100))).toBe(true);
            expect(result.consumed).toBe(utf8ByteLength(result.patch));
        });

        it('keeps the produced patch within the byte allocation for multibyte (CJK) diffs', () => {
            // A char-count budget would let this through: `.length` is a third
            // of the real byte size, so a 3-byte/char diff measured in UTF-16
            // units understates its BSON footprint by ~3x.
            const cjk = '漢'.repeat(MAX_PATCH_BYTES_PER_FILE); // 3x the cap in bytes
            const result = budgetPatchForPersist(cjk, MAX_PATCH_BYTES_PER_FILE);
            expect(result.truncated).toBe(true);
            expect(utf8ByteLength(result.patch)).toBeLessThanOrEqual(
                MAX_PATCH_BYTES_PER_FILE,
            );
            expect(result.patch.endsWith(TRUNCATED_DIFF_MARKER)).toBe(true);
            expect(result.consumed).toBe(utf8ByteLength(result.patch));
        });

        it('never splits a surrogate pair when truncating', () => {
            const emoji = '😀'.repeat(MAX_PATCH_BYTES_PER_FILE); // 4 bytes each
            const result = budgetPatchForPersist(emoji, 1000);
            // No lone surrogate may survive: the body must round-trip cleanly.
            expect(
                /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result.patch),
            ).toBe(false);
            expect(utf8ByteLength(result.patch)).toBeLessThanOrEqual(1000);
        });

        it('respects a tight remaining aggregate budget even for one patch', () => {
            const patch = 'z'.repeat(10_000);
            const remaining = 2000;
            const result = budgetPatchForPersist(patch, remaining);
            expect(result.truncated).toBe(true);
            expect(utf8ByteLength(result.patch)).toBeLessThanOrEqual(remaining);
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
            const r2 = budgetPatchForPersist(
                'b'.repeat(500_000),
                500_000 - r1.consumed,
            );
            expect(r2.truncated).toBe(true);
            expect(r1.consumed + r2.consumed).toBeLessThanOrEqual(500_000);
        });
    });

    describe('clampPatchForPersist', () => {
        it('passes a small patch through unchanged', () => {
            const patch = 'y'.repeat(MAX_PATCH_BYTES_PER_FILE - 1);
            expect(clampPatchForPersist(patch)).toBe(patch);
        });

        it('truncates an oversized patch and appends the marker', () => {
            const clamped = clampPatchForPersist(
                'y'.repeat(MAX_PATCH_BYTES_PER_FILE * 2),
            );
            expect(utf8ByteLength(clamped)).toBeLessThanOrEqual(
                MAX_PATCH_BYTES_PER_FILE,
            );
            expect(clamped.endsWith(TRUNCATED_DIFF_MARKER)).toBe(true);
        });

        it('clamps by bytes for a multibyte patch', () => {
            const clamped = clampPatchForPersist(
                '漢'.repeat(MAX_PATCH_BYTES_PER_FILE),
            );
            expect(utf8ByteLength(clamped)).toBeLessThanOrEqual(
                MAX_PATCH_BYTES_PER_FILE,
            );
            expect(clamped.endsWith(TRUNCATED_DIFF_MARKER)).toBe(true);
        });

        it('reports the truncation flag so the repository can mirror it', () => {
            expect(clampPatchForPersistWithFlag('y'.repeat(10)).truncated).toBe(
                false,
            );
            const clamped = clampPatchForPersistWithFlag(
                'y'.repeat(MAX_PATCH_BYTES_PER_FILE * 2),
            );
            expect(clamped.truncated).toBe(true);
            expect(clamped.patch.endsWith(TRUNCATED_DIFF_MARKER)).toBe(true);
        });
    });
});
