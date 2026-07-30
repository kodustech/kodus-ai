import {
    compileRuleDetector,
    isDetectorRegexSafe,
    runDetector,
    RunCompiler,
    DetectorPlan,
} from './kody-rules-detector.compiler';

const rule = (over: any = {}): any => ({
    uuid: 'r1',
    title: 't',
    rule: 'r',
    examples: [
        { isCorrect: false, snippet: 'console.log(x)' },
        { isCorrect: true, snippet: 'logger.debug(x)' },
    ],
    ...over,
});

const compiler = (out: any): RunCompiler => async () => out;

describe('compileRuleDetector — the gate (#1449 T0)', () => {
    it('promotes a mechanical rule whose regex reproduces its examples', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ mechanical: true, pattern: 'console\\.(log|warn|error)\\(' }),
        );
        expect(res.detector).not.toBeNull();
        expect(res.detector!.pattern).toContain('console');
    });

    it('declines a rule the model says is not mechanical', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ mechanical: false, reason: 'needs judgment' }),
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('not-mechanical');
    });

    it('declines when the regex is invalid', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ mechanical: true, pattern: '(' }),
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('invalid-regex');
    });

    it('declines when the regex misses an incorrect example (recall gate)', async () => {
        const res = await compileRuleDetector(
            rule(),
            compiler({ mechanical: true, pattern: 'NEVER_MATCHES' }),
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('missed-incorrect-example');
    });

    it('declines when the regex flags a correct example (precision gate)', async () => {
        // `\blog\b` matches both console.log AND logger.debug? no — but matches
        // "logger.debug"? no. Use a loose regex that hits the correct example.
        const res = await compileRuleDetector(
            rule({
                examples: [
                    { isCorrect: false, snippet: 'const x: any = 1' },
                    { isCorrect: true, snippet: 'let anyway = 1' }, // "any" as a word
                ],
            }),
            compiler({ mechanical: true, pattern: '\\bany' }), // hits "anyway"
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('flagged-correct-example');
    });

    it('declines a loose regex that over-matches a real-code corpus', async () => {
        const corpus = [
            'const a = 1',
            '// pick any value',
            'return anyOf(x)',
            'const s = "many"',
            'log.info("ok")',
        ];
        const res = await compileRuleDetector(
            rule({
                examples: [
                    { isCorrect: false, snippet: 'const x: any = 1' },
                    { isCorrect: true, snippet: 'const y: number = 1' },
                ],
            }),
            // matches the intended site AND "any" inside comments/strings
            compiler({ mechanical: true, pattern: 'any' }),
            { corpus, maxCorpusMatchRate: 0.02 },
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('over-matches-corpus');
    });

    it('declines a ReDoS-prone regex (nested quantifier) — unsafe-regex', async () => {
        const res = await compileRuleDetector(
            rule({
                examples: [
                    { isCorrect: false, snippet: 'aaaa' },
                    { isCorrect: true, snippet: 'b' },
                ],
            }),
            compiler({ mechanical: true, pattern: '(a+)+$' }),
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('unsafe-regex');
    });

    it('declines when there are no labeled examples and no corpus', async () => {
        const res = await compileRuleDetector(
            rule({ examples: [] }),
            compiler({ mechanical: true, pattern: 'x' }),
        );
        expect(res.detector).toBeNull();
        expect(res.declineReason).toBe('no-usable-examples');
    });
});

describe('isDetectorRegexSafe — ReDoS guard', () => {
    it('rejects nested quantifiers', () => {
        expect(isDetectorRegexSafe('(a+)+$')).toBe(false);
        expect(isDetectorRegexSafe('(a*)*')).toBe(false);
        expect(isDetectorRegexSafe('([a-z]+)*')).toBe(false);
    });
    it('rejects bounded outer quantifiers on an inner-quantified group (#1480 review)', () => {
        // `{n,}`/`{n,m}` are just as catastrophic as a bare `*`/`+` when
        // applied to a group that already contains its own quantifier —
        // the pre-fix heuristic only matched a bare `*`/`+` right after
        // the group, so these slipped through.
        expect(isDetectorRegexSafe('(a+){3,}')).toBe(false);
        expect(isDetectorRegexSafe('(a*){5}')).toBe(false);
        expect(isDetectorRegexSafe('(a+){1,100}')).toBe(false);
    });
    it('accepts ordinary detector patterns', () => {
        expect(isDetectorRegexSafe('console\\.(log|warn|error)\\(')).toBe(true);
        expect(isDetectorRegexSafe('\\bDateTime\\.now\\s*\\(')).toBe(true);
    });
    it('accepts a plain quantified char class — not a nested-quantifier shape (#1480 review)', () => {
        // Regression guard: the char-class branch of the ReDoS regex
        // used to flag ANY class followed by a quantifier, regardless of
        // the class's content — so `[a-z]+`, one of the most common
        // regex shapes, was wrongly declined as unsafe. A class only
        // becomes suspect when it itself contains a quantifier-ish
        // char (e.g. `[a-z+]{2,}`), mirroring the group check.
        expect(isDetectorRegexSafe('[a-z]+')).toBe(true);
        expect(isDetectorRegexSafe('[a-zA-Z0-9_]+')).toBe(true);
        expect(isDetectorRegexSafe('[a-z]*')).toBe(true);
    });
    it('rejects an over-long pattern', () => {
        expect(isDetectorRegexSafe('a'.repeat(201))).toBe(false);
    });
});

describe('runDetector — review-time regex over added lines', () => {
    const plan: DetectorPlan = {
        type: 'regex',
        pattern: 'console\\.(log|warn|error)\\(',
    };
    it('flags only ADDED lines that match, with file+line', () => {
        const hits = runDetector(plan, [
            {
                filename: 'src/a.ts',
                patchWithLinesStr:
                    '10 +console.log(1)\n11  const ok = 1\n12 +doThing()\n13 +console.warn(2)',
            },
        ]);
        expect(hits).toEqual([
            { filename: 'src/a.ts', line: 10, code: 'console.log(1)' },
            { filename: 'src/a.ts', line: 13, code: 'console.warn(2)' },
        ]);
    });

    it('ignores context (non-+) lines even if they match', () => {
        const hits = runDetector(plan, [
            { filename: 'src/a.ts', patchWithLinesStr: '5  console.log(untouched)' },
        ]);
        expect(hits).toHaveLength(0);
    });
});
