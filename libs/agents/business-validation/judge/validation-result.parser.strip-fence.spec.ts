import { stripCodeFence } from './validation-result.parser';

// Compatibility cases, not fix coverage: the outputs callers have always
// seen (the former regex produced them too, so these pass on both revisions
// by design). The fix is pinned by the regression block below.
describe('stripCodeFence compatibility', () => {
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
});

// Regression: fails on the former regex (~2.4s on this input).
describe('stripCodeFence regression', () => {
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
