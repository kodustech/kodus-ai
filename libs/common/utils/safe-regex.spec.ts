import { isRegexSafe, matchAllWithin } from './safe-regex';

// The id and line matchers teams and detectors write: kept, and fast.
const KEPT = [
    'sc-(\\d+)',
    'TCK-(\\d+)',
    '\\[(GE-\\d+)\\]',
    'console\\.(log|warn|error)\\(',
    '\\bDateTime\\.now\\s*\\(',
    '[a-z]+-\\d+',
    '\\(a+\\)+',
];

describe('isRegexSafe', () => {
    it('refuses a repeated group holding a quantifier, nested or bounded', () => {
        for (const p of [
            '(a+)+$',
            '(a*)*',
            '((a+))+',
            '(a+){3,}',
            '(?:\\w+\\s?)*$',
            '(a?)+$',
        ]) {
            expect(isRegexSafe(p)).toBe(false);
        }
    });

    it('refuses a repeated alternation, which backtracks just as badly', () => {
        for (const p of ['(a|a)*$', '(a|aa)+$', '((a|b))+', '(?:x|xy){2,}']) {
            expect(isRegexSafe(p)).toBe(false);
        }
    });

    it('keeps the id and line matchers teams and detectors write', () => {
        for (const p of KEPT) {
            expect(isRegexSafe(p)).toBe(true);
        }
    });

    it('refuses what does not parse or is too long', () => {
        for (const p of ['', '(', 'a)', '[abc', 'x'.repeat(201)]) {
            expect(isRegexSafe(p)).toBe(false);
        }
    });

    // The refusals above keep the catastrophic patterns out; what it lets
    // through must run fast on the line that hangs them.
    it('lets through only patterns that run fast on a short adversarial line', () => {
        const line = `${'a'.repeat(28)}!`;
        for (const p of KEPT) {
            const started = Date.now();
            new RegExp(p).test(line);
            expect(Date.now() - started).toBeLessThan(50);
        }
    });
});

describe('matchAllWithin', () => {
    it('reads every match and its first group', () => {
        expect(matchAllWithin('T(\\d{4})', 'feat T1234 and T5678')).toEqual([
            { index: 5, text: 'T1234', group: '1234' },
            { index: 15, text: 'T5678', group: '5678' },
        ]);
    });

    // `[A-Z]+\w*-\d+` passes the shape check and grows cubically on a long
    // run of capitals: a PR title its author wrote must not hang the review.
    it('stops a pattern that runs past its time and matches nothing', () => {
        const pattern = '[A-Z]+\\w*-\\d+';
        expect(isRegexSafe(pattern)).toBe(true);
        const started = Date.now();
        expect(matchAllWithin(pattern, `${'A'.repeat(3000)}!`, 50)).toEqual([]);
        expect(Date.now() - started).toBeLessThan(1000);
    });
});
