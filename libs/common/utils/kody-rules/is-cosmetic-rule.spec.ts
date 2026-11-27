import { isCosmeticRule } from './is-cosmetic-rule';

describe('isCosmeticRule', () => {
    it.each([
        [
            'Parameterized queries',
            'Bind SQL parameters instead of building queries with single quotes.',
        ],
        [
            'Reject semicolons in untrusted input',
            'Reject additional SQL statements in a parameter.',
        ],
        [
            'Preserve signed payloads',
            'Do not remove trailing whitespace from signed payloads.',
        ],
        ['Semicolons in HTTP headers', 'Reject malformed headers.'],
        [
            'Validate requests',
            'Reject unexpected fields.\nFor example: blank lines can conceal a second request.',
        ],
        ['Check routes', 'Semicolons?debug=true must be rejected.'],
        ['Check paths', 'Indentation!important is a literal path component.'],
        [
            'Quote SQL parameters',
            'Ruby does not require semicolons inside bound parameters.',
        ],
    ])('keeps the substantive rule "%s" eligible', (title, rule) => {
        expect(isCosmeticRule({ title, rule })).toBe(false);
    });

    it.each([
        'Semicolons',
        'Avoid unnecessary semicolons at the end of statements.',
        'Always use double-quoted strings for attribute values',
        'Do not leave two consecutive blank lines',
        'Remove trailing whitespace.',
        'Use two spaces for indentation, never tabs',
        'Keep line length under 120 characters',
        'Write one statement per line',
        'Avoid unnecessary semicolons; use the formatter to fix them.',
        'Tabs vs. spaces',
        'Ruby does not require semicolons',
        "Ruby doesn't require semicolons to terminate statements.",
    ])('recognizes a formatting directive in either field: %s', (directive) => {
        expect(isCosmeticRule({ title: directive })).toBe(true);
        expect(isCosmeticRule({ rule: directive })).toBe(true);
    });
});
