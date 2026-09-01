/**
 * Mutation-killing unit tests for TokenChunkingService.
 *
 * Covers the deterministic surface: chunkDataByTokens (public) plus the
 * private helpers countTokensForItem, serializeItem, isOpenAIModel,
 * getOpenAIModelName and getCircularReplacer, reached via `(svc as any)`.
 *
 * `tiktoken` is mocked so the OpenAI counting branch is deterministic and we
 * can prove it is actually taken (and that its inner catch falls back to
 * estimation). Everything else uses the real estimation path, whose token
 * count for ASCII text is `Math.floor(byteLength / 4)`.
 */

jest.mock('tiktoken', () => ({
    encoding_for_model: jest.fn(),
}));

import { encoding_for_model } from 'tiktoken';
import { TokenChunkingService } from './tokenChunking.service';
import { LLMModelProvider } from '@libs/llm/model-providers';

describe('TokenChunkingService', () => {
    let svc: TokenChunkingService;

    beforeEach(() => {
        jest.clearAllMocks();
        svc = new TokenChunkingService();
    });

    // Helper: an ASCII string of exactly `n` bytes → floor(n/4) estimated tokens.
    const strOf = (bytes: number) => 'a'.repeat(bytes);

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
        it('estimates via floor(bytes/4) for non-OpenAI models', () => {
            // 8 ASCII bytes → floor(8/4) = 2. tiktoken must NOT be consulted.
            expect(
                (svc as any).countTokensForItem(
                    strOf(8),
                    LLMModelProvider.GEMINI_2_5_PRO,
                ),
            ).toBe(2);
            expect(encoding_for_model).not.toHaveBeenCalled();
        });

        it('estimates when no model is provided', () => {
            expect((svc as any).countTokensForItem(strOf(12))).toBe(3);
            expect(encoding_for_model).not.toHaveBeenCalled();
        });

        it('serializes objects before estimating', () => {
            // JSON.stringify({a:"bb"}) === '{"a":"bb"}' → 10 bytes → floor = 2.
            expect((svc as any).countTokensForItem({ a: 'bb' })).toBe(2);
        });

        it('uses tiktoken for OpenAI models and passes the tail model name', () => {
            (encoding_for_model as jest.Mock).mockReturnValue({
                encode: () => ({ length: 42 }),
            });
            const result = (svc as any).countTokensForItem(
                strOf(400),
                LLMModelProvider.OPENAI_GPT_4O,
            );
            // 42 comes from tiktoken, NOT floor(400/4)=100 → branch proven.
            expect(result).toBe(42);
            expect(encoding_for_model).toHaveBeenCalledWith('gpt-4o');
        });

        it('falls back to estimation when tiktoken throws for an OpenAI model', () => {
            (encoding_for_model as jest.Mock).mockImplementation(() => {
                throw new Error('no encoder');
            });
            // 8 bytes → floor(8/4) = 2 (the estimation fallback).
            expect(
                (svc as any).countTokensForItem(
                    strOf(8),
                    LLMModelProvider.OPENAI_GPT_4O,
                ),
            ).toBe(2);
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
            // GEMINI_2_5_PRO window is 1_000_000; 1% → floor(10000) = 10000.
            const res = svc.chunkDataByTokens({
                data: [strOf(4)],
                model: LLMModelProvider.GEMINI_2_5_PRO,
                usagePercentage: 1,
            });
            expect(res.tokenLimit).toBe(10000);
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
            // tokenLimit = floor(20 * 100/100) = 20; each item = floor(40/4)=10.
            // Two 10-token items fit exactly (10+10=20, not > 20); a third
            // starts a new chunk. If the boundary were >= it would split earlier.
            const items = [
                strOf(40),
                strOf(40),
                strOf(40),
                strOf(40),
                strOf(40),
            ];
            const res = svc.chunkDataByTokens({
                data: items,
                defaultMaxTokens: 20,
                usagePercentage: 100,
            });
            expect(res.tokenLimit).toBe(20);
            expect(res.totalItems).toBe(5);
            expect(res.totalChunks).toBe(3);
            expect(res.chunks).toEqual([
                [items[0], items[1]],
                [items[2], items[3]],
                [items[4]],
            ]);
            expect(res.tokensPerChunk).toEqual([20, 20, 10]);
        });

        it('emits an oversized item as its own chunk after flushing the current one', () => {
            // limit = 20. item0 = 10 tokens, item1 = 30 tokens (> 20), item2 = 10.
            const items = [strOf(40), strOf(120), strOf(40)];
            const res = svc.chunkDataByTokens({
                data: items,
                defaultMaxTokens: 20,
                usagePercentage: 100,
            });
            expect(res.chunks).toEqual([[items[0]], [items[1]], [items[2]]]);
            expect(res.tokensPerChunk).toEqual([10, 30, 10]);
            expect(res.totalChunks).toBe(3);
        });

        it('emits a leading oversized item without an empty preceding chunk', () => {
            // First item already exceeds the limit and currentChunk is empty.
            const items = [strOf(120), strOf(40)];
            const res = svc.chunkDataByTokens({
                data: items,
                defaultMaxTokens: 20,
                usagePercentage: 100,
            });
            expect(res.chunks).toEqual([[items[0]], [items[1]]]);
            expect(res.tokensPerChunk).toEqual([30, 10]);
        });

        it('skips null/undefined items but still counts them in totalItems', () => {
            const valid = strOf(40); // 10 tokens
            const res = svc.chunkDataByTokens({
                data: [null, valid, undefined],
                defaultMaxTokens: 20,
                usagePercentage: 100,
            });
            expect(res.totalItems).toBe(3); // data.length, includes the holes
            expect(res.totalChunks).toBe(1);
            expect(res.chunks).toEqual([[valid]]);
            expect(res.tokensPerChunk).toEqual([10]);
        });

        it('keeps a single small item in one chunk', () => {
            const res = svc.chunkDataByTokens({
                data: [strOf(40)],
                defaultMaxTokens: 20,
                usagePercentage: 100,
            });
            expect(res.totalChunks).toBe(1);
            expect(res.chunks).toEqual([[strOf(40)]]);
            expect(res.tokensPerChunk).toEqual([10]);
            expect(res.totalItems).toBe(1);
        });
    });
});
