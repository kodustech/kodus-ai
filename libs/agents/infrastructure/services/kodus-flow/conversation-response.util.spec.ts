import {
    CONVERSATION_FALLBACK_MESSAGE,
    normalizeConversationResponse,
} from './conversation-response.util';

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
    });

    it('unwraps a JSON-string { content } envelope', () => {
        expect(
            normalizeConversationResponse('{"content":"real answer"}'),
        ).toBe('real answer');
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

    it('exposes a non-empty fallback message', () => {
        expect(CONVERSATION_FALLBACK_MESSAGE.trim().length).toBeGreaterThan(0);
    });
});
