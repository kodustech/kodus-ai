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
});
