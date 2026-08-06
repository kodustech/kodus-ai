import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterReviewFiles } from '../review-file-filter.js';

describe('filterReviewFiles', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not print skip warnings when quiet is enabled', () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const oversizedDiff = 'x'.repeat(1024 * 1024 + 1);

        const result = filterReviewFiles(
            [
                {
                    path: 'big.ts',
                    content: 'const ok = true;',
                    status: 'modified',
                    diff: oversizedDiff,
                },
            ],
            true,
        );

        expect(result).toHaveLength(0);
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('prints skip warnings when quiet is disabled', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const oversizedDiff = 'x'.repeat(1024 * 1024 + 1);

        const result = filterReviewFiles(
            [
                {
                    path: 'big.ts',
                    content: 'const ok = true;',
                    status: 'modified',
                    diff: oversizedDiff,
                },
            ],
            false,
        );

        expect(result).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalled();
    });

    it('keeps files within the API diff limit and skips those above it', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const result = filterReviewFiles(
            [
                {
                    path: 'ok.ts',
                    content: 'const ok = true;',
                    status: 'modified',
                    diff: 'x'.repeat(500_000 - 1),
                },
                {
                    path: 'too-big.ts',
                    content: 'const ok = true;',
                    status: 'modified',
                    diff: 'x'.repeat(500_000 + 1),
                },
            ],
            false,
        );

        expect(result.map((file) => file.path)).toEqual(['ok.ts']);
        expect(warnSpy).toHaveBeenCalled();
    });

    it('keeps files within the API content limit and skips those above it', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const result = filterReviewFiles(
            [
                {
                    path: 'ok.ts',
                    content: 'x'.repeat(2_000_000 - 1),
                    status: 'modified',
                    diff: '+1',
                },
                {
                    path: 'too-big.ts',
                    content: 'x'.repeat(2_000_000 + 1),
                    status: 'modified',
                    diff: '+1',
                },
            ],
            false,
        );

        expect(result.map((file) => file.path)).toEqual(['ok.ts']);
        expect(warnSpy).toHaveBeenCalled();
    });
});
