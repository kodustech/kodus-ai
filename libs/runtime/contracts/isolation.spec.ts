import { CELL_ISOLATIONS, isolationSatisfies, isolationsSatisfying } from './isolation';

describe('isolation minimums', () => {
    it('a claim goes only to a cell at its minimum or above, never lower', () => {
        const takes = (min: 'any' | 'kernel' | 'vm') => CELL_ISOLATIONS.filter((cell) => isolationSatisfies(cell, min));
        expect(takes('any')).toEqual(['vm', 'microvm', 'sandboxed-container', 'none']);
        expect(takes('kernel')).toEqual(['vm', 'microvm', 'sandboxed-container']);
        expect(takes('vm')).toEqual(['vm', 'microvm']);
    });

    it('a claim that names no minimum takes any cell', () => {
        expect(isolationSatisfies('none', undefined)).toBe(true);
        expect([...isolationsSatisfying()]).toEqual([...CELL_ISOLATIONS]);
    });

    it('a cell whose isolation is unknown satisfies only any', () => {
        expect(isolationSatisfies('chroot', 'kernel')).toBe(false);
        expect(isolationSatisfies(undefined, 'vm')).toBe(false);
        expect(isolationSatisfies(null, 'any')).toBe(true);
    });
});
