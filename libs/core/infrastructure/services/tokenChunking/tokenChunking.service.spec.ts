/**
 * Mutation-killing unit tests for TokenChunkingService.
 *
 * Covers the deterministic surface: chunkDataByTokens (public) plus the
 * private helpers countTokensForItem, serializeItem, isOpenAIModel,
 * getOpenAIModelName and getCircularReplacer, reached via `(svc as any)`.
 *
 * `tiktoken`'s `encoding_for_model` is mocked so the OpenAI counting branch is
 * deterministic and we can prove it is actually taken (and that its inner catch
 * falls back to estimation). Everything else uses the real estimation path,
 * which MEASURES with the tokenizer rather than dividing byte length — so the
 * expectations below are derived from that same function instead of restating
 * an arithmetic rule that is no longer the implementation.
 */

// Only `encoding_for_model` is mocked — that is the OpenAI branch this file
// drives deterministically. `get_encoding` is kept REAL, because the estimation
// branch now measures with it; mocking it away silently degraded the estimator
// to its char fallback and made every expectation below about the fallback
// ratio instead of about the behaviour under test.
jest.mock('tiktoken', () => ({
    ...jest.requireActual('tiktoken'),
    encoding_for_model: jest.fn(),
}));

import { encoding_for_model } from 'tiktoken';
import { TokenChunkingService } from './tokenChunking.service';
import { LLMModelProvider } from '@libs/llm/model-providers';
import { estimateTextTokens } from '@libs/llm/token-estimate';

describe('TokenChunkingService', () => {
    let svc: TokenChunkingService;

    beforeEach(() => {
        jest.clearAllMocks();
        svc = new TokenChunkingService();
    });

    const strOf = (bytes: number) => 'a'.repeat(bytes);
    /** What the service will actually count for a string. Derived, never
     *  restated: a hardcoded number here would pin an arithmetic rule rather
     *  than the behaviour, which is how these cases came to describe
     *  `floor(bytes/4)` — a formula the service had stopped using. */
    const tokensOf = (text: string) => estimateTextTokens(text);

    describe('isOpenAIModel', () => {
        it('returns true for exactly the four listed OpenAI models', () => {
            expect(
                (svc as any).isOpenAIModel(LLMModelProvider.OPENAI_GPT_4O),
            ).toBe(true);
            expect(
                (svc as any).isOpenAIModel(LLMModelProvider.OPENAI_GPT_4O_MINI),
            ).toBe(true);
            expect(
                (svc as any).isOpenAIModel(LLMModelProvider.OPENAI_GPT_4_1),
            ).toBe(true);
            expect(
                (svc as any).isOpenAIModel(LLMModelProvider.OPENAI_GPT_O4_MINI),
            ).toBe(true);
        });

        it('returns false for an OpenAI model NOT in the list (GPT_5_1)', () => {
            // Proves the allow-list is an exact set, not a prefix match.
            expect(
                (svc as any).isOpenAIModel(LLMModelProvider.OPENAI_GPT_5_1),
            ).toBe(false);
        });

        it('returns false for non-OpenAI models and arbitrary strings', () => {
            expect(
                (svc as any).isOpenAIModel(LLMModelProvider.CLAUDE_SONNET_4_5),
            ).toBe(false);
            expect(
                (svc as any).isOpenAIModel(LLMModelProvider.GEMINI_2_5_PRO),
            ).toBe(false);
            expect((svc as any).isOpenAIModel('openai:gpt-4o')).toBe(true);
            expect((svc as any).isOpenAIModel('some-byok-model')).toBe(false);
        });
    });

    describe('getOpenAIModelName', () => {
        it('returns the tail after the colon', () => {
            expect(
                (svc as any).getOpenAIModelName(LLMModelProvider.OPENAI_GPT_4O),
            ).toBe('gpt-4o');
            expect(
                (svc as any).getOpenAIModelName(
                    LLMModelProvider.OPENAI_GPT_4_1,
                ),
            ).toBe('gpt-4.1');
            expect(
                (svc as any).getOpenAIModelName(
                    LLMModelProvider.OPENAI_GPT_O4_MINI,
                ),
            ).toBe('o4-mini');
        });

        it('returns the whole string when there is no colon', () => {
            expect((svc as any).getOpenAIModelName('gpt-4o')).toBe('gpt-4o');
        });

        it('falls back to gpt-4o when the tail is empty', () => {
            // ''.split(':').pop() === '' → the || default applies.
            expect((svc as any).getOpenAIModelName('')).toBe('gpt-4o');
        });
    });

    describe('getCircularReplacer', () => {
        it('passes primitives and null through unchanged', () => {
            const replacer = (svc as any).getCircularReplacer();
            expect(replacer('k', 5)).toBe(5);
            expect(replacer('k', 'text')).toBe('text');
            expect(replacer('k', null)).toBe(null);
        });

        it('returns the object the first time and [Circular] on repeat', () => {
            const replacer = (svc as any).getCircularReplacer();
            const obj = { a: 1 };
            expect(replacer('first', obj)).toBe(obj);
            expect(replacer('second', obj)).toBe('[Circular]');
        });
    });

    describe('serializeItem', () => {
        it('returns strings verbatim', () => {
            expect((svc as any).serializeItem('hello')).toBe('hello');
        });

        it('JSON-stringifies plain objects', () => {
            expect((svc as any).serializeItem({ a: 'bb', n: 1 })).toBe(
                '{"a":"bb","n":1}',
            );
        });

        it('coerces null / undefined / numbers via String()', () => {
            expect((svc as any).serializeItem(null)).toBe('null');
            expect((svc as any).serializeItem(undefined)).toBe('undefined');
            expect((svc as any).serializeItem(42)).toBe('42');
        });

        it('uses the circular replacer when JSON.stringify throws on a cycle', () => {
            const obj: any = { name: 'root' };
            obj.self = obj;
            const out = (svc as any).serializeItem(obj);
            expect(out).toContain('[Circular]');
            expect(out).toContain('"name":"root"');
        });

        it('falls back to String(item) when even the replacer path throws', () => {
            // A BigInt property makes both JSON.stringify calls throw, so the
            // last-resort String(item) branch runs.
            const out = (svc as any).serializeItem({ big: 1n });
            expect(out).toBe('[object Object]');
        });
    });

    describe('countTokensForItem', () => {
        it('measures a non-OpenAI model without consulting encoding_for_model', () => {
            // The point of the case is the BRANCH, not the arithmetic: this path
            // estimates and must not reach for the OpenAI encoder.
            expect(
                (svc as any).countTokensForItem(
                    strOf(8),
                    LLMModelProvider.GEMINI_2_5_PRO,
                ),
            ).toBe(tokensOf(strOf(8)));
            expect(encoding_for_model).not.toHaveBeenCalled();
        });

        it('estimates when no model is provided', () => {
            expect((svc as any).countTokensForItem(strOf(12))).toBe(
                tokensOf(strOf(12)),
            );
            expect(encoding_for_model).not.toHaveBeenCalled();
        });

        it('serializes objects before estimating', () => {
            // The behaviour under test is that an object is serialized first —
            // so the expectation is the count of its serialization.
            expect((svc as any).countTokensForItem({ a: 'bb' })).toBe(
                tokensOf(JSON.stringify({ a: 'bb' })),
            );
        });

        it('uses tiktoken for OpenAI models and passes the tail model name', () => {
            (encoding_for_model as jest.Mock).mockReturnValue({
                encode: () => ({ length: 42 }),
            });
            const result = (svc as any).countTokensForItem(
                strOf(400),
                LLMModelProvider.OPENAI_GPT_4O,
            );
            // 42 comes from tiktoken, not from the estimator → branch proven.
            expect(result).toBe(42);
            expect(encoding_for_model).toHaveBeenCalledWith('gpt-4o');
        });

        it('falls back to estimation when tiktoken throws for an OpenAI model', () => {
            (encoding_for_model as jest.Mock).mockImplementation(() => {
                throw new Error('no encoder');
            });
            // Falls back to the estimation path, whatever that path counts.
            expect(
                (svc as any).countTokensForItem(
                    strOf(8),
                    LLMModelProvider.OPENAI_GPT_4O,
                ),
            ).toBe(tokensOf(strOf(8)));
            expect(encoding_for_model).toHaveBeenCalled();
        });
    });

    describe('chunkDataByTokens - guards', () => {
        const emptyShape = {
            chunks: [],
            totalItems: 0,
            totalChunks: 0,
            tokensPerChunk: [],
            tokenLimit: 0,
        };

        it('returns an empty result with modelUsed "default" for null data', () => {
            expect(svc.chunkDataByTokens({ data: null as any })).toEqual({
                ...emptyShape,
                modelUsed: 'default',
            });
        });

        it('returns an empty result for non-array data and echoes the model', () => {
            expect(
                svc.chunkDataByTokens({
                    data: 'not-an-array' as any,
                    model: 'foo',
                }),
            ).toEqual({ ...emptyShape, modelUsed: 'foo' });
        });

        it('returns an empty result for an empty array', () => {
            expect(svc.chunkDataByTokens({ data: [] })).toEqual({
                ...emptyShape,
                modelUsed: 'default',
            });
        });
    });

    describe('chunkDataByTokens - token limit computation', () => {
        it('applies the default 60% of the default 64000 budget', () => {
            // floor(64000 * 60 / 100) = 38400.
            const res = svc.chunkDataByTokens({ data: [strOf(4)] });
            expect(res.tokenLimit).toBe(38400);
            expect(res.modelUsed).toBe('default');
        });

        it('derives the limit from a managed model window', () => {
            // GEMINI_2_5_PRO window is 1_048_576; 1% → floor(10485.76) = 10485.
            // It was 1_000_000 while this read a hand-typed registry entry.
            const res = svc.chunkDataByTokens({
                data: [strOf(4)],
                model: LLMModelProvider.GEMINI_2_5_PRO,
                usagePercentage: 1,
            });
            expect(res.tokenLimit).toBe(10485);
            expect(res.modelUsed).toBe('google:gemini-2.5-pro');
        });

        it('lets overrideMaxTokens take priority over the model window', () => {
            // floor(1000 * 50 / 100) = 500.
            const res = svc.chunkDataByTokens({
                data: [strOf(4)],
                model: LLMModelProvider.GEMINI_2_5_PRO,
                overrideMaxTokens: 1000,
                usagePercentage: 50,
            });
            expect(res.tokenLimit).toBe(500);
        });

        it('ignores overrideMaxTokens when it is 0 (not > 0)', () => {
            // Falls back to defaultMaxTokens: floor(200 * 100 / 100) = 200.
            const res = svc.chunkDataByTokens({
                data: [strOf(4)],
                overrideMaxTokens: 0,
                defaultMaxTokens: 200,
                usagePercentage: 100,
            });
            expect(res.tokenLimit).toBe(200);
        });
    });

    describe('chunkDataByTokens - splitting', () => {
        it('packs items up to the limit and honours the strict > boundary', () => {
            // The rule, not the arithmetic: a budget of exactly TWO items means
            // two fit (sum == limit, not > limit) and a third starts a new
            // chunk. If the boundary were >= it would split one item earlier.
            const one = strOf(40);
            const per = tokensOf(one);
            const items = [one, one, one, one, one];
            const res = svc.chunkDataByTokens({
                data: items,
                defaultMaxTokens: per * 2,
                usagePercentage: 100,
            });
            expect(res.tokenLimit).toBe(per * 2);
            expect(res.totalItems).toBe(5);
            expect(res.totalChunks).toBe(3);
            expect(res.chunks).toEqual([
                [items[0], items[1]],
                [items[2], items[3]],
                [items[4]],
            ]);
            expect(res.tokensPerChunk).toEqual([per * 2, per * 2, per]);
        });

        it('emits an oversized item as its own chunk after flushing the current one', () => {
            const small = strOf(40);
            const big = strOf(4_000);
            const per = tokensOf(small);
            const items = [small, big, small];
            const res = svc.chunkDataByTokens({
                data: items,
                defaultMaxTokens: per * 2,
                usagePercentage: 100,
            });
            expect(res.chunks).toEqual([[items[0]], [items[1]], [items[2]]]);
            expect(res.tokensPerChunk).toEqual([per, tokensOf(big), per]);
            expect(res.totalChunks).toBe(3);
        });

        it('emits a leading oversized item without an empty preceding chunk', () => {
            // First item already exceeds the limit and currentChunk is empty.
            const small = strOf(40);
            const big = strOf(4_000);
            const items = [big, small];
            const res = svc.chunkDataByTokens({
                data: items,
                defaultMaxTokens: tokensOf(small) * 2,
                usagePercentage: 100,
            });
            expect(res.chunks).toEqual([[items[0]], [items[1]]]);
            expect(res.tokensPerChunk).toEqual([
                tokensOf(big),
                tokensOf(small),
            ]);
        });

        it('skips null/undefined items but still counts them in totalItems', () => {
            const valid = strOf(40);
            const res = svc.chunkDataByTokens({
                data: [null, valid, undefined],
                defaultMaxTokens: tokensOf(valid) * 2,
                usagePercentage: 100,
            });
            expect(res.totalItems).toBe(3); // data.length, includes the holes
            expect(res.totalChunks).toBe(1);
            expect(res.chunks).toEqual([[valid]]);
            expect(res.tokensPerChunk).toEqual([tokensOf(valid)]);
        });

        it('keeps a single small item in one chunk', () => {
            const res = svc.chunkDataByTokens({
                data: [strOf(40)],
                defaultMaxTokens: tokensOf(strOf(40)) * 2,
                usagePercentage: 100,
            });
            expect(res.totalChunks).toBe(1);
            expect(res.chunks).toEqual([[strOf(40)]]);
            expect(res.tokensPerChunk).toEqual([tokensOf(strOf(40))]);
            expect(res.totalItems).toBe(1);
        });
    });
});
