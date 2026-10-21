import { isRegexSafe } from './safe-regex';

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
