import { isSuggestionId, SUGGESTION_ID_REGEX } from './suggestion-id';

describe('isSuggestionId', () => {
    it('accepts an RFC-4122 UUID', () => {
        expect(isSuggestionId('123e4567-e89b-12d3-a456-426614174000')).toBe(
            true,
        );
    });

    it('accepts a 24-char Mongo ObjectId hex string', () => {
        expect(isSuggestionId('6a4fe1f32a96eaa5460394b9')).toBe(true);
    });

    it('rejects a non-string', () => {
        expect(isSuggestionId(12345)).toBe(false);
        expect(isSuggestionId(null)).toBe(false);
        expect(isSuggestionId(undefined)).toBe(false);
    });

    it('rejects strings that are neither UUID nor ObjectId', () => {
        expect(isSuggestionId('not-a-uuid')).toBe(false);
        expect(isSuggestionId('6a4fe1f32a96eaa5460394b')).toBe(false);
        expect(isSuggestionId('')).toBe(false);
    });

    it('exports a regex whose source matches the same ids', () => {
        expect(SUGGESTION_ID_REGEX.test('6a4fe1f32a96eaa5460394b9')).toBe(true);
        expect(
            SUGGESTION_ID_REGEX.test('123e4567-e89b-12d3-a456-426614174000'),
        ).toBe(true);
    });
});
