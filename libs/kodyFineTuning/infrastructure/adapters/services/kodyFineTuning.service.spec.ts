import { KodyFineTuningService } from './kodyFineTuning.service';
import { FeedbackType } from '@libs/kodyFineTuning/domain/enums/feedbackType.enum';
import { ICodeReviewFeedback } from '@libs/code-review/domain/codeReviewFeedback/interfaces/codeReviewFeedback.interface';
import { ISuggestionToEmbed } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

/**
 * Mutation-focused unit tests for the deterministic helper methods of
 * KodyFineTuningService: normalizeText, identifyFeedbackType and
 * removeDuplicateAndNeutralSuggestions.
 *
 * These methods use none of the injected dependencies, so the service is
 * constructed with inert `{} as any` stubs and the private methods are reached
 * via `(service as any)`.
 */
describe('KodyFineTuningService deterministic helpers', () => {
    let service: KodyFineTuningService;

    beforeEach(() => {
        service = new KodyFineTuningService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
    });

    const normalize = (text: any): string =>
        (service as any).normalizeText(text);
    const identify = (feedback: any): string =>
        (service as any).identifyFeedbackType(feedback);
    const dedup = (
        withFeedback: any,
        implemented: any,
    ): Promise<{
        uniqueSuggestionsWithFeedback: ISuggestionToEmbed[];
        uniqueImplementedSuggestions: ISuggestionToEmbed[];
    }> =>
        (service as any).removeDuplicateAndNeutralSuggestions(
            withFeedback,
            implemented,
        );

    describe('normalizeText', () => {
        it('returns empty string for falsy input (empty string)', () => {
            expect(normalize('')).toBe('');
        });

        it('returns empty string for null input', () => {
            expect(normalize(null)).toBe('');
        });

        it('returns empty string for undefined input', () => {
            expect(normalize(undefined)).toBe('');
        });

        it('lowercases the text', () => {
            expect(normalize('HELLO')).toBe('hello');
        });

        it('strips diacritics via NFD decomposition', () => {
            expect(normalize('Café')).toBe('cafe');
            expect(normalize('Héllo Wörld')).toBe('hello world');
        });

        it('replaces disallowed characters with a single space', () => {
            // '@' and '#' are not in the allowed set → each becomes a space,
            // then collapsed to a single space.
            expect(normalize('a@#b')).toBe('a b');
        });

        it('preserves the explicitly allowed punctuation characters', () => {
            // word chars, dash, underscore, dot, () {} [] are all preserved.
            expect(normalize('Foo-Bar_1.2(3)[4]{5}')).toBe(
                'foo-bar_1.2(3)[4]{5}',
            );
        });

        it('collapses runs of whitespace into a single space', () => {
            expect(normalize('a   b')).toBe('a b');
        });

        it('trims leading and trailing whitespace', () => {
            expect(normalize('   a b   ')).toBe('a b');
        });

        it('applies the full pipeline in combination', () => {
            expect(normalize('  Héllo,  Wörld!! ')).toBe('hello world');
        });
    });

    describe('identifyFeedbackType', () => {
        it('returns NEUTRAL when feedback is null', () => {
            expect(identify(null)).toBe(FeedbackType.NEUTRAL);
        });

        it('returns NEUTRAL when feedback has no reactions field', () => {
            expect(identify({} as ICodeReviewFeedback)).toBe(
                FeedbackType.NEUTRAL,
            );
        });

        it('returns NEUTRAL when reactions is null', () => {
            expect(identify({ reactions: null } as any)).toBe(
                FeedbackType.NEUTRAL,
            );
        });

        it('returns POSITIVE_REACTION when thumbsUp > 0 and > thumbsDown', () => {
            expect(
                identify({ reactions: { thumbsUp: 1, thumbsDown: 0 } } as any),
            ).toBe(FeedbackType.POSITIVE_REACTION);
            expect(
                identify({ reactions: { thumbsUp: 2, thumbsDown: 1 } } as any),
            ).toBe(FeedbackType.POSITIVE_REACTION);
        });

        it('returns NEGATIVE_REACTION when thumbsDown > 0 and > thumbsUp', () => {
            expect(
                identify({ reactions: { thumbsUp: 0, thumbsDown: 1 } } as any),
            ).toBe(FeedbackType.NEGATIVE_REACTION);
            expect(
                identify({ reactions: { thumbsUp: 1, thumbsDown: 2 } } as any),
            ).toBe(FeedbackType.NEGATIVE_REACTION);
        });

        it('returns NEUTRAL when thumbsUp equals thumbsDown (tie, boundary for > vs >=)', () => {
            expect(
                identify({ reactions: { thumbsUp: 1, thumbsDown: 1 } } as any),
            ).toBe(FeedbackType.NEUTRAL);
        });

        it('returns NEUTRAL when both counts are zero', () => {
            expect(
                identify({ reactions: { thumbsUp: 0, thumbsDown: 0 } } as any),
            ).toBe(FeedbackType.NEUTRAL);
        });

        it('keeps NEUTRAL when thumbsUp is 0 even if thumbsDown is negative (kills thumbsUp>0 -> >=0 mutant)', () => {
            expect(
                identify({ reactions: { thumbsUp: 0, thumbsDown: -1 } } as any),
            ).toBe(FeedbackType.NEUTRAL);
        });

        it('keeps NEUTRAL when thumbsDown is 0 even if thumbsUp is negative (kills thumbsDown>0 -> >=0 mutant)', () => {
            expect(
                identify({ reactions: { thumbsUp: -1, thumbsDown: 0 } } as any),
            ).toBe(FeedbackType.NEUTRAL);
        });
    });

    describe('removeDuplicateAndNeutralSuggestions', () => {
        it('drops neutral feedback and duplicates (implemented ids), keeping order and exact membership', async () => {
            const withFeedback = [
                {
                    id: 's1',
                    feedbackType: FeedbackType.POSITIVE_REACTION,
                    extra: 'a',
                },
                { id: 's2', feedbackType: FeedbackType.NEUTRAL },
                { id: 's3', feedbackType: FeedbackType.NEGATIVE_REACTION },
                { id: 's4', feedbackType: FeedbackType.POSITIVE_REACTION },
            ] as any as ISuggestionToEmbed[];

            const implemented = [
                { id: 's3', feedbackType: FeedbackType.NEUTRAL, foo: 1 },
                {
                    id: 's4',
                    feedbackType: FeedbackType.POSITIVE_REACTION,
                    foo: 2,
                },
            ] as any as ISuggestionToEmbed[];

            const result = await dedup(withFeedback, implemented);

            // Only s1 survives: s2 is neutral, s3 & s4 are implemented (dupes).
            // s4 (implemented AND positive) proves the condition is AND, not OR.
            expect(result.uniqueSuggestionsWithFeedback).toEqual([
                {
                    id: 's1',
                    feedbackType: FeedbackType.POSITIVE_REACTION,
                    extra: 'a',
                },
            ]);
        });

        it('does not drop a non-implemented, non-neutral suggestion sharing no id', async () => {
            const withFeedback = [
                { id: 'a', feedbackType: FeedbackType.POSITIVE_REACTION },
                { id: 'b', feedbackType: FeedbackType.NEGATIVE_REACTION },
            ] as any as ISuggestionToEmbed[];

            const result = await dedup(withFeedback, [] as any);

            expect(result.uniqueSuggestionsWithFeedback).toEqual([
                { id: 'a', feedbackType: FeedbackType.POSITIVE_REACTION },
                { id: 'b', feedbackType: FeedbackType.NEGATIVE_REACTION },
            ]);
        });

        it('overwrites feedbackType of implemented suggestions with SUGGESTION_IMPLEMENTED, preserving other fields and order', async () => {
            const implemented = [
                { id: 's3', feedbackType: FeedbackType.NEUTRAL, foo: 1 },
                {
                    id: 's4',
                    feedbackType: FeedbackType.POSITIVE_REACTION,
                    foo: 2,
                },
            ] as any as ISuggestionToEmbed[];

            const result = await dedup([] as any, implemented);

            expect(result.uniqueImplementedSuggestions).toEqual([
                {
                    id: 's3',
                    feedbackType: FeedbackType.SUGGESTION_IMPLEMENTED,
                    foo: 1,
                },
                {
                    id: 's4',
                    feedbackType: FeedbackType.SUGGESTION_IMPLEMENTED,
                    foo: 2,
                },
            ]);
        });

        it('returns empty arrays for empty inputs', async () => {
            const result = await dedup([] as any, [] as any);
            expect(result.uniqueSuggestionsWithFeedback).toEqual([]);
            expect(result.uniqueImplementedSuggestions).toEqual([]);
        });

        it('falls back to the original inputs when processing throws (implemented is null)', async () => {
            const withFeedback = [
                { id: 'x', feedbackType: FeedbackType.POSITIVE_REACTION },
            ] as any as ISuggestionToEmbed[];

            // implemented === null → .map() throws → catch returns inputs as-is.
            const result = await dedup(withFeedback, null);

            expect(result.uniqueSuggestionsWithFeedback).toBe(withFeedback);
            expect(result.uniqueImplementedSuggestions).toBeNull();
        });
    });
});
