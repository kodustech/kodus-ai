import { getOpenAIEmbedding } from '@libs/common/utils/document';
import { FeedbackType } from '@libs/kodyFineTuning/domain/enums/feedbackType.enum';
import { SuggestionEmbeddedService } from './suggestionEmbedded.service';

/**
 * Mutation-focused unit tests for the deterministic logic of
 * SuggestionEmbeddedService: countWithLanguages, embeddingText and
 * isValidSuggestion (the predicate that produces the "clean suggestions" set).
 *
 * These methods do not use the injected repository, so the service is built
 * with an inert `{} as any` stub and private methods are reached via
 * `(service as any)`. `getOpenAIEmbedding` is module-mocked because
 * embeddingText delegates to it.
 */
jest.mock('@libs/common/utils/document', () => ({
    getOpenAIEmbedding: jest.fn(),
}));

const mockedGetOpenAIEmbedding = getOpenAIEmbedding as jest.Mock;

describe('SuggestionEmbeddedService deterministic logic', () => {
    let service: SuggestionEmbeddedService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new SuggestionEmbeddedService({} as any);
    });

    const countWithLanguages = (result: any) =>
        (service as any).countWithLanguages(result);
    const embeddingText = (suggestion: any) =>
        (service as any).embeddingText(suggestion);
    const isValidSuggestion = (s: any) => (service as any).isValidSuggestion(s);

    describe('countWithLanguages', () => {
        it('classifies POSITIVE_REACTION and SUGGESTION_IMPLEMENTED as positive and NEGATIVE_REACTION as negative, and counts per language exactly', async () => {
            const result = [
                {
                    feedbackType: FeedbackType.POSITIVE_REACTION,
                    language: 'typescript',
                },
                {
                    feedbackType: FeedbackType.SUGGESTION_IMPLEMENTED,
                    language: 'typescript',
                },
                {
                    feedbackType: FeedbackType.POSITIVE_REACTION,
                    language: 'python',
                },
                {
                    feedbackType: FeedbackType.NEGATIVE_REACTION,
                    language: 'go',
                },
                {
                    feedbackType: FeedbackType.NEGATIVE_REACTION,
                    language: 'go',
                },
                { feedbackType: FeedbackType.NEUTRAL, language: 'rust' },
            ];

            const out = await countWithLanguages(result);

            expect(out).toEqual({
                positiveFeedbacks: {
                    language: [
                        { language: 'typescript', count: 2 },
                        { language: 'python', count: 1 },
                    ],
                    total: 3,
                },
                negativeFeedbacks: {
                    language: [{ language: 'go', count: 2 }],
                    total: 2,
                },
                total: 6,
            });
        });

        it('does NOT count NEUTRAL as positive or negative', async () => {
            const out = await countWithLanguages([
                { feedbackType: FeedbackType.NEUTRAL, language: 'typescript' },
            ]);

            expect(out).toEqual({
                positiveFeedbacks: { language: [], total: 0 },
                negativeFeedbacks: { language: [], total: 0 },
                total: 1,
            });
        });

        it('skips entries with a falsy language (no bucket created)', async () => {
            const out = await countWithLanguages([
                { feedbackType: FeedbackType.POSITIVE_REACTION, language: '' },
                {
                    feedbackType: FeedbackType.POSITIVE_REACTION,
                    language: undefined,
                },
                { feedbackType: FeedbackType.NEGATIVE_REACTION },
            ]);

            // language buckets empty, but totals still count the entries
            expect(out).toEqual({
                positiveFeedbacks: { language: [], total: 2 },
                negativeFeedbacks: { language: [], total: 1 },
                total: 3,
            });
        });

        it('returns all-empty shape for an empty input array', async () => {
            const out = await countWithLanguages([]);

            expect(out).toEqual({
                positiveFeedbacks: { language: [], total: 0 },
                negativeFeedbacks: { language: [], total: 0 },
                total: 0,
            });
        });

        it('preserves first-seen language order and increments (not resets) on repeats', async () => {
            const out = await countWithLanguages([
                { feedbackType: FeedbackType.POSITIVE_REACTION, language: 'b' },
                { feedbackType: FeedbackType.POSITIVE_REACTION, language: 'a' },
                { feedbackType: FeedbackType.POSITIVE_REACTION, language: 'b' },
                { feedbackType: FeedbackType.POSITIVE_REACTION, language: 'b' },
            ]);

            expect(out.positiveFeedbacks.language).toEqual([
                { language: 'b', count: 3 },
                { language: 'a', count: 1 },
            ]);
            expect(out.positiveFeedbacks.total).toBe(4);
        });
    });

    describe('embeddingText', () => {
        it('returns the embedding array when all required fields are present', async () => {
            mockedGetOpenAIEmbedding.mockResolvedValue({
                data: [{ embedding: [0.1, 0.2, 0.3] }],
            });

            const out = await embeddingText({
                suggestionContent: 'content',
                oneSentenceSummary: 'summary',
                label: 'bug',
            });

            expect(out).toEqual([0.1, 0.2, 0.3]);
        });

        it('builds the embed text as "content summary label" with single-space separators', async () => {
            mockedGetOpenAIEmbedding.mockResolvedValue({
                data: [{ embedding: [1] }],
            });

            await embeddingText({
                suggestionContent: 'C',
                oneSentenceSummary: 'S',
                label: 'L',
            });

            expect(mockedGetOpenAIEmbedding).toHaveBeenCalledTimes(1);
            expect(mockedGetOpenAIEmbedding).toHaveBeenCalledWith('C S L');
        });

        it('returns null when suggestionContent is missing (does not call the embedder)', async () => {
            const out = await embeddingText({
                oneSentenceSummary: 'summary',
                label: 'bug',
            });

            expect(out).toBeNull();
            expect(mockedGetOpenAIEmbedding).not.toHaveBeenCalled();
        });

        it('returns null when oneSentenceSummary is missing', async () => {
            const out = await embeddingText({
                suggestionContent: 'content',
                label: 'bug',
            });

            expect(out).toBeNull();
            expect(mockedGetOpenAIEmbedding).not.toHaveBeenCalled();
        });

        it('returns null when label is missing', async () => {
            const out = await embeddingText({
                suggestionContent: 'content',
                oneSentenceSummary: 'summary',
            });

            expect(out).toBeNull();
            expect(mockedGetOpenAIEmbedding).not.toHaveBeenCalled();
        });

        it('returns null when the suggestion itself is null', async () => {
            const out = await embeddingText(null);

            expect(out).toBeNull();
            expect(mockedGetOpenAIEmbedding).not.toHaveBeenCalled();
        });

        it('returns undefined when the embedder yields an empty data array', async () => {
            mockedGetOpenAIEmbedding.mockResolvedValue({ data: [] });

            const out = await embeddingText({
                suggestionContent: 'content',
                oneSentenceSummary: 'summary',
                label: 'bug',
            });

            expect(out).toBeUndefined();
        });

        it('returns undefined when the embedder resolves undefined', async () => {
            mockedGetOpenAIEmbedding.mockResolvedValue(undefined);

            const out = await embeddingText({
                suggestionContent: 'content',
                oneSentenceSummary: 'summary',
                label: 'bug',
            });

            expect(out).toBeUndefined();
        });
    });

    describe('isValidSuggestion', () => {
        const validBase = () => ({
            id: '123e4567-e89b-12d3-a456-426614174000',
            suggestionContent: 'content',
            oneSentenceSummary: 'summary',
            label: 'bug',
            severity: 'high',
            feedbackType: FeedbackType.POSITIVE_REACTION,
        });

        it('accepts a fully valid suggestion', () => {
            expect(isValidSuggestion(validBase())).toBe(true);
        });

        it('rejects null and undefined', () => {
            expect(isValidSuggestion(null)).toBe(false);
            expect(isValidSuggestion(undefined)).toBe(false);
        });

        it('rejects a non-string id', () => {
            expect(isValidSuggestion({ ...validBase(), id: 12345 })).toBe(
                false,
            );
        });

        it('rejects an id that is neither a UUID nor an ObjectId', () => {
            expect(
                isValidSuggestion({ ...validBase(), id: 'not-a-uuid' }),
            ).toBe(false);
        });

        it('accepts a 24-char Mongo ObjectId hex id', () => {
            expect(
                isValidSuggestion({
                    ...validBase(),
                    id: '6a4fe1f32a96eaa5460394b9',
                }),
            ).toBe(true);
        });

        it('rejects when suggestionContent is missing', () => {
            const s = validBase();
            delete s.suggestionContent;
            expect(isValidSuggestion(s)).toBe(false);
        });

        it('rejects when oneSentenceSummary is missing', () => {
            const s = validBase();
            delete s.oneSentenceSummary;
            expect(isValidSuggestion(s)).toBe(false);
        });

        it('rejects when label is missing', () => {
            const s = validBase();
            delete s.label;
            expect(isValidSuggestion(s)).toBe(false);
        });

        it('rejects when severity is missing', () => {
            const s = validBase();
            delete s.severity;
            expect(isValidSuggestion(s)).toBe(false);
        });

        it('rejects when feedbackType is missing', () => {
            const s = validBase();
            delete s.feedbackType;
            expect(isValidSuggestion(s)).toBe(false);
        });
    });
});
