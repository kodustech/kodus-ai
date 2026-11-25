import { normalizeConversationResponse } from './conversation-response.util';

describe('normalizeConversationResponse', () => {
    it('returns a plain string answer unchanged', () => {
        expect(normalizeConversationResponse('Here is the answer')).toBe(
            'Here is the answer',
        );
    });

    it('trims surrounding whitespace', () => {
        expect(normalizeConversationResponse('  hello  ')).toBe('hello');
    });

    it('unwraps a { content } envelope object', () => {
        expect(normalizeConversationResponse({ content: 'real answer' })).toBe(
            'real answer',
        );
        expect(
            normalizeConversationResponse({ content: 'x', extra: { a: 1 } }),
        ).toBe('x');
    });

    it('unwraps a JSON-string { content } envelope', () => {
        expect(normalizeConversationResponse('{"content":"real answer"}')).toBe(
            'real answer',
        );
    });

    it('unwraps nested { content } envelopes', () => {
        expect(
            normalizeConversationResponse({
                content: { content: 'deep answer' },
            }),
        ).toBe('deep answer');
    });

    it('returns null for an empty { content } envelope object', () => {
        expect(normalizeConversationResponse({ content: '' })).toBeNull();
    });

    it('returns null for the {"content":""} JSON string the LLM echoes', () => {
        expect(normalizeConversationResponse('{"content":""}')).toBeNull();
    });

    it('returns null for an empty or whitespace-only string', () => {
        expect(normalizeConversationResponse('')).toBeNull();
        expect(normalizeConversationResponse('   ')).toBeNull();
    });

    it('returns null for an empty object, null and undefined', () => {
        expect(normalizeConversationResponse({})).toBeNull();
        expect(normalizeConversationResponse(null)).toBeNull();
        expect(normalizeConversationResponse(undefined)).toBeNull();
    });

    it('preserves a real JSON answer that is not a content envelope', () => {
        expect(normalizeConversationResponse('{"foo":1}')).toBe('{"foo":1}');
    });

    // Only a `content` key is an envelope; any other non-string shape nulls out
    // so the caller posts the fallback, never a wrong answer.
    it('returns null for any non-string shape without a content key', () => {
        for (const value of [
            ['a', 'b'],
            [],
            { result: 'x' },
            { Content: 'x' },
            { choices: [{ message: { content: 'buried' } }] },
            { error: 'boom' },
            true,
            0,
        ]) {
            expect(normalizeConversationResponse(value)).toBeNull();
        }
    });

    it('keeps text that only looks like an envelope as the literal reply', () => {
        for (const text of [
            '```json\n{"content":"x"}\n```',
            'Here is the result: {"content":"x"}',
            '{"content":"ans',
            '{content: "x"}',
        ]) {
            expect(normalizeConversationResponse(text)).toBe(text);
        }
    });
});
