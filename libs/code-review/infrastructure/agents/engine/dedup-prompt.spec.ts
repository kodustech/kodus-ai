import { collapseNearDuplicates, contentSimilarity } from './dedup-prompt';

// Jaccard is over 3+ char word tokens of summary+improvedCode+content. Using
// distinct words keeps the similarity math exact and the tests deterministic.
const sug = (relevantFile: string, suggestionContent: string) => ({
    relevantFile,
    suggestionContent,
});

describe('collapseNearDuplicates', () => {
    it('collapses paraphrases of the same bug, keeping the most detailed one', () => {
        const a = sug('a.ts', 'alpha bravo charlie');
        const aRicher = sug('a.ts', 'alpha bravo charlie delta echo foxtrot');
        // sim(a, aRicher) = |{alpha,bravo,charlie}| / |6 words| = 0.5 >= 0.3
        expect(contentSimilarity(a, aRicher)).toBeGreaterThanOrEqual(0.3);

        const out = collapseNearDuplicates([a, aRicher]);
        expect(out).toHaveLength(1);
        expect(out[0]).toBe(aRicher); // the richer (more detailed) representative
    });

    it('keeps DISTINCT bugs in the same file separate (low similarity)', () => {
        const nullBug = sug('a.ts', 'alpha bravo charlie');
        const timeoutBug = sug('a.ts', 'delta echo foxtrot golf');
        expect(contentSimilarity(nullBug, timeoutBug)).toBeLessThan(0.3);

        const out = collapseNearDuplicates([nullBug, timeoutBug]);
        expect(out).toHaveLength(2);
    });

    it('never collapses across files, even with identical content', () => {
        const out = collapseNearDuplicates([
            sug('a.ts', 'alpha bravo charlie'),
            sug('b.ts', 'alpha bravo charlie'),
        ]);
        expect(out).toHaveLength(2);
    });

    it('re-evaluates a promoted representative against the rest of the bucket', () => {
        // x and y are NOT similar (share only "charlie" → Jaccard 0.2), so they
        // start as two separate representatives in the same file.
        const x = sug('a.ts', 'alpha bravo charlie');
        const y = sug('a.ts', 'charlie delta echo');
        expect(contentSimilarity(x, y)).toBeLessThan(0.3);

        // z is richer AND similar to BOTH x and y (0.6 each). It first matches x
        // and is promoted; the re-eval must then fold y too, or the cluster stays
        // split and both z and y reach verify.
        const z = sug('a.ts', 'alpha bravo charlie delta echo');
        expect(contentSimilarity(z, x)).toBeGreaterThanOrEqual(0.3);
        expect(contentSimilarity(z, y)).toBeGreaterThanOrEqual(0.3);

        const out = collapseNearDuplicates([x, y, z]);
        expect(out).toHaveLength(1); // without the re-eval fold this would be 2
        expect(out[0]).toBe(z);
    });

    it('returns an empty array unchanged', () => {
        expect(collapseNearDuplicates([])).toEqual([]);
    });
});
