import { parseViolations, scoreCase, normalizePath } from './behavioral-scoring';

describe('parseViolations — unwrap the model JSON', () => {
    it('parses plain JSON', () => {
        expect(
            parseViolations('{"violations":[{"ruleUuid":"a","relevantLinesStart":3}]}'),
        ).toHaveLength(1);
    });

    it('unwraps a ```json fenced block', () => {
        const t = 'Sure:\n```json\n{"violations":[{"ruleUuid":"a"}]}\n```\ndone';
        expect(parseViolations(t)).toEqual([{ ruleUuid: 'a' }]);
    });

    it('extracts JSON embedded in prose (no fence)', () => {
        const t = 'Here you go {"violations":[{"ruleUuid":"x"}]} thanks';
        expect(parseViolations(t)).toEqual([{ ruleUuid: 'x' }]);
    });

    it('returns [] for empty/undefined/garbage/no-violations-key', () => {
        expect(parseViolations('')).toEqual([]);
        expect(parseViolations(undefined)).toEqual([]);
        expect(parseViolations('not json at all')).toEqual([]);
        expect(parseViolations('{"foo":1}')).toEqual([]);
        expect(parseViolations('{"violations":"nope"}')).toEqual([]);
    });
});

describe('scoreCase — occurrence recall + on-target within ±tol', () => {
    const sites = [
        { file: 'a.ts', line: 10 },
        { file: 'a.ts', line: 20 },
        { file: 'b.ts', line: 5 },
    ];

    it('counts an exact-line hit', () => {
        const r = scoreCase(sites, [{ file: 'a.ts', line: 10 }], 2);
        expect(r.caught).toBe(1);
        expect(r.onTarget).toBe(1);
    });

    it('counts a hit within the ±tolerance (line 22 covers site 20)', () => {
        expect(scoreCase(sites, [{ file: 'a.ts', line: 22 }], 2).caught).toBe(1);
    });

    it('misses a flag just outside the tolerance (line 23 vs site 20, tol 2)', () => {
        const r = scoreCase(sites, [{ file: 'a.ts', line: 23 }], 2);
        expect(r.caught).toBe(0);
        expect(r.onTarget).toBe(0);
    });

    it('does not credit a hit on the wrong file', () => {
        expect(scoreCase(sites, [{ file: 'b.ts', line: 10 }], 2).caught).toBe(0);
    });

    it('counts each ground-truth site at most once and marks stray flags off-target', () => {
        const flags = [
            { file: 'a.ts', line: 10 }, // on site 10
            { file: 'a.ts', line: 11 }, // also near site 10 (still 1 site caught)
            { file: 'z.ts', line: 99 }, // off-target
        ];
        const r = scoreCase(sites, flags, 2);
        expect(r.caught).toBe(1); // only site 10 covered, not double-counted
        expect(r.onTarget).toBe(2); // two flags near a real site; z.ts is off
    });
});

describe('normalizePath', () => {
    it('strips leading slashes and trims', () => {
        expect(normalizePath('/src/a.ts')).toBe('src/a.ts');
        expect(normalizePath('  x.ts ')).toBe('x.ts');
        expect(normalizePath(undefined)).toBe('');
    });
});
