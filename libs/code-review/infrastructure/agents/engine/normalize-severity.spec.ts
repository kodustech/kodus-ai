import { normalizeSuggestionSeverity } from './normalize-severity';

describe('normalizeSuggestionSeverity', () => {
    it.each([
        ['critical', 'critical'],
        ['HIGH', 'high'],
        ['Medium', 'medium'],
        ['low', 'low'],
        ['major', 'medium'],
        ['', 'medium'],
        [undefined, 'medium'],
    ])('reads %p as %p', (input, expected) => {
        expect(normalizeSuggestionSeverity(input)).toBe(expected);
    });
});
