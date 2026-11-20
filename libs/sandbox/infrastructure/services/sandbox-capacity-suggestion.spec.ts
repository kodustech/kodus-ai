import { suggestMaxConcurrent } from './sandbox-capacity-suggestion';

describe('suggestMaxConcurrent', () => {
    it('is null when the cell is unknown', () => {
        expect(suggestMaxConcurrent(null)).toBeNull();
        expect(suggestMaxConcurrent({ allocatableMemoryMb: null, sandboxMemoryMb: 2048 })).toBeNull();
        expect(suggestMaxConcurrent({ allocatableMemoryMb: 14000, sandboxMemoryMb: null })).toBeNull();
    });
    it('leaves room for one 12 GB Run claim', () => {
        // (20480 - 12288) / 2048 = 4
        expect(suggestMaxConcurrent({ allocatableMemoryMb: 20_480, sandboxMemoryMb: 2048 })).toBe(4);
    });
    it('falls back to what fits when no Run could fit anyway', () => {
        expect(suggestMaxConcurrent({ allocatableMemoryMb: 7168, sandboxMemoryMb: 2048 })).toBe(3);
    });
});
