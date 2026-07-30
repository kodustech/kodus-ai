import {
    firstNonEmptyString,
    firstNonEmptyValue,
    normalizeParamName,
    tryParseJsonString,
    uniqueNonEmpty,
} from './text-utils';

describe('task-context text-utils (characterization)', () => {
    describe('tryParseJsonString', () => {
        it('parses object/array-looking strings', () => {
            expect(tryParseJsonString('{"a":1}')).toEqual({ a: 1 });
            expect(tryParseJsonString('  [1,2] ')).toEqual([1, 2]);
        });
        it('returns undefined for non-JSON-looking or invalid input', () => {
            expect(tryParseJsonString('hello')).toBeUndefined();
            expect(tryParseJsonString('')).toBeUndefined();
            expect(tryParseJsonString('{not json}')).toBeUndefined();
        });
    });

    describe('firstNonEmptyString', () => {
        it('returns the first non-blank string', () => {
            expect(firstNonEmptyString(['', '  ', 'x', 'y'])).toBe('x');
        });
        it('skips non-strings and returns undefined when none', () => {
            expect(firstNonEmptyString([1, null, '  '])).toBeUndefined();
        });
    });

    describe('firstNonEmptyValue', () => {
        it('returns the first non-blank string OR any non-null value', () => {
            expect(firstNonEmptyValue(['', '  ', 'x'])).toBe('x');
            expect(firstNonEmptyValue(['', 0])).toBe(0);
            expect(firstNonEmptyValue(['', null, undefined])).toBeUndefined();
        });
    });

    describe('normalizeParamName', () => {
        it('strips to alphanumerics, lowercased', () => {
            expect(normalizeParamName('Issue-Key_2')).toBe('issuekey2');
            expect(normalizeParamName('  pull request #  ')).toBe('pullrequest');
        });
    });

    describe('uniqueNonEmpty', () => {
        it('dedupes and drops blanks', () => {
            expect(uniqueNonEmpty(['a', 'a', '', '  ', 'b'])).toEqual(['a', 'b']);
        });
    });
});
