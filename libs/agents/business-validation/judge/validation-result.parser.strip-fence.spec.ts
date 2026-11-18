import { stripCodeFence } from './validation-result.parser';

// The regex stripCodeFence replaced; kept here as the reference contract.
function legacyStripCodeFence(value: string): string {
    const trimmed = value.trim();
    const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (!fencedMatch || !fencedMatch[1]) {
        return trimmed;
    }
    return fencedMatch[1].trim();
}

describe('stripCodeFence', () => {
    it.each([
        '```json\n{"needsMoreInfo": false}\n```',
        '```JSON\n{"a": 1}\n```',
        '```\n{"a": 1}\n```',
        '  ```json {"a": 1} ```  ',
        '```jsonx```',
        '```json```',
        '``````',
        '````',
        '```',
        '{"a": 1}',
        'plain text',
        '```json\n{"a": "```"}\n```',
        '```json\n\n   \n```',
        '```json\n{"a": 1}',
        '{"a": 1}\n```',
        '',
    ])('matches the former regex on %p', (input) => {
        expect(stripCodeFence(input)).toBe(legacyStripCodeFence(input));
    });

    it('answers fast on a fenced reply that never closes', () => {
        // A model reply cut at max tokens: open fence, indented JSON, no close.
        const truncated =
            '```json\n{\n' +
            '        "field": "value",\n'.repeat(400) +
            ' '.repeat(4_000) +
            'x';
        const started = Date.now();
        expect(stripCodeFence(truncated)).toBe(truncated.trim());
        expect(Date.now() - started).toBeLessThan(50);
    });
});
