import { openAiModelListing } from './listing';

/**
 * OpenAI's `/models` returns every model the key can reach — embeddings,
 * speech, image, legacy completions — and the picker showed all of them next
 * to the chat models a review can actually run on (production screenshot,
 * 2026-09-25: "Babbage 002", "Chatgpt Image Latest", "Computer Use Preview").
 * The native listing keeps only the chat/reasoning models.
 */
describe('openAiModelListing — native OpenAI keeps chat models only', () => {
    const native = openAiModelListing('openai')!;
    const ids = (raw: string[]) =>
        (native as any)
            .parse({ object: 'list', data: raw.map((id) => ({ id })) })
            .map((m: { id: string }) => m.id);

    it.each([
        'babbage-002',
        'davinci-002',
        'chatgpt-image-latest',
        'gpt-image-1',
        'dall-e-3',
        'computer-use-preview',
        'computer-use-preview-2025-03-11',
        'text-embedding-3-large',
        'tts-1-hd',
        'gpt-4o-mini-tts',
        'whisper-1',
        'gpt-4o-transcribe',
        'omni-moderation-latest',
        'gpt-realtime',
        'gpt-4o-realtime-preview',
        'gpt-4o-audio-preview',
        'sora-2',
    ])('drops %s', (id) => {
        expect(ids([id])).toEqual([]);
    });

    it.each([
        'gpt-5.6-terra',
        'gpt-6-sol',
        'gpt-4.1',
        'gpt-4o',
        'o3',
        'o4-mini',
        'chat-latest',
        'gpt-5-codex',
    ])('keeps %s', (id) => {
        expect(ids([id])).toEqual([id]);
    });

    it('lists from the fixed OpenAI endpoint with the key as Bearer', () => {
        expect(native.kind).toBe('http');
        expect((native as any).apiKeyEnv).toBe('API_OPEN_AI_API_KEY');
        expect((native as any).url({ apiKey: 'k' })).toBe(
            'https://api.openai.com/v1/models',
        );
        expect((native as any).headers({ apiKey: 'k' })).toEqual(
            expect.objectContaining({ Authorization: 'Bearer k' }),
        );
    });

    it('drops a bare legacy id and keeps one that only contains the word', () => {
        expect(ids(['babbage', 'davinci'])).toEqual([]);
        expect(ids(['gpt-imagery-7'])).toEqual(['gpt-imagery-7']);
    });

    it('does not filter a custom endpoint — its ids belong to the customer', () => {
        const compatible = openAiModelListing('openai_compatible')!;
        const out = (compatible as any).parse({
            data: [{ id: 'whisper-large-v3' }, { id: 'my-model' }],
        });
        expect(out.map((m: { id: string }) => m.id)).toEqual([
            'whisper-large-v3',
            'my-model',
        ]);
    });
});
