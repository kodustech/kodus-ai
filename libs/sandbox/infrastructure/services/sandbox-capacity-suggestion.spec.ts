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

import { aggregateCellFacts } from './sandbox-capacity-suggestion';

describe('aggregateCellFacts', () => {
    it('is null with no cell', () => expect(aggregateCellFacts([])).toBeNull());
    it('sums memory and takes the largest sandbox size', () => {
        expect(
            aggregateCellFacts([
                { allocatableMb: 10_000, sandboxMemoryMb: 2048, sandboxCpus: 2 },
                { allocatableMb: 20_000, sandboxMemoryMb: 4096, sandboxCpus: 4 },
                { allocatableMb: null, sandboxMemoryMb: null, sandboxCpus: null },
            ]),
        ).toEqual({ allocatableMemoryMb: 30_000, sandboxMemoryMb: 4096, sandboxCpus: 4, poolReady: null, poolTarget: null });
    });
    it('sums the warm pool of the cells that reported one, null when none did', () => {
        const base = { allocatableMb: 1, sandboxMemoryMb: 2048, sandboxCpus: 2 };
        expect(aggregateCellFacts([{ ...base, poolReady: 2, poolTarget: 4 }, { ...base, poolReady: 1, poolTarget: 4 }, base])).toMatchObject({ poolReady: 3, poolTarget: 8 });
        expect(aggregateCellFacts([base])).toMatchObject({ poolReady: null, poolTarget: null });
    });
    it('keeps unknown memory null (no suggestion)', () => {
        expect(aggregateCellFacts([{ allocatableMb: null, sandboxMemoryMb: 2048, sandboxCpus: 2 }])?.allocatableMemoryMb).toBeNull();
    });
});
