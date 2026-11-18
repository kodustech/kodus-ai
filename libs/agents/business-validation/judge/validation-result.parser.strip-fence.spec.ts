import { stripCodeFence } from './validation-result.parser';

describe('stripCodeFence', () => {
    // The contract, as explicit input -> output pairs (the outputs the former
    // regex produced, so callers see no change).
    it.each([
        ['```json\n{"needsMoreInfo": false}\n```', '{"needsMoreInfo": false}'],
        ['```JSON\n{"a": 1}\n```', '{"a": 1}'],
        ['```\n{"a": 1}\n```', '{"a": 1}'],
        ['  ```json {"a": 1} ```  ', '{"a": 1}'],
        ['```jsonx```', 'x'],
        ['```json```', '```json```'],
        ['``````', '``````'],
        ['````', '````'],
        ['```', '```'],
        ['{"a": 1}', '{"a": 1}'],
        ['plain text', 'plain text'],
        ['```json\n{"a": "```"}\n```', '{"a": "```"}'],
        ['```json\n\n   \n```', '```json\n\n   \n```'],
        ['```json\n{"a": 1}', '```json\n{"a": 1}'],
        ['{"a": 1}\n```', '{"a": 1}\n```'],
        ['', ''],
    ])('strips %p to %p', (input, expected) => {
        expect(stripCodeFence(input)).toBe(expected);
    });

    it('answers fast on a fenced reply that never closes', () => {
        // A model reply cut at max tokens: open fence, indented JSON, a long
        // whitespace run, no close. The former regex is quadratic in that
        // run: ~2.4s here (measured), against a few ms now.
        const truncated =
            '```json\n{\n' +
            '        "field": "value",\n'.repeat(400) +
            ' '.repeat(40_000) +
            'x';
        const started = Date.now();
        expect(stripCodeFence(truncated)).toBe(truncated.trim());
        expect(Date.now() - started).toBeLessThan(50);
    });
});
