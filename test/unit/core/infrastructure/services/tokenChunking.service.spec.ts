import { TokenChunkingService } from '@libs/core/infrastructure/services/tokenChunking/tokenChunking.service';
import { LLMModelProvider, MODEL_STRATEGIES } from '@kodus/kodus-common/llm';

// Mock logger
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

// Mock tiktoken to avoid native dependency in tests
jest.mock('tiktoken', () => ({
    encoding_for_model: jest.fn().mockReturnValue({
        encode: (text: string) => new Array(Math.ceil(text.length / 4)),
    }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a string of approximately `tokenCount` tokens.
 * estimateTokenCount uses Math.floor(byteCount / 4) for non-OpenAI models.
 * For ASCII text, byteCount ≈ string.length, so we need ~tokenCount * 4 chars.
 */
function generateItem(tokenCount: number, seed = 'item'): string {
    const charCount = tokenCount * 4;
    const base = `${seed}_`;
    return base + 'x'.repeat(Math.max(0, charCount - base.length));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('TokenChunkingService – overrideMaxTokens', () => {
    let service: TokenChunkingService;

    beforeEach(() => {
        service = new TokenChunkingService();
    });

    // -----------------------------------------------------------------
    // Baseline: without overrideMaxTokens
    // -----------------------------------------------------------------

    describe('without overrideMaxTokens', () => {
        it('should use model strategy inputMaxTokens when model is provided', () => {
            const modelMaxTokens =
                MODEL_STRATEGIES[LLMModelProvider.GEMINI_2_5_PRO]
                    .inputMaxTokens;

            // Single small item that fits in any budget
            const result = service.chunkDataByTokens({
                model: LLMModelProvider.GEMINI_2_5_PRO,
                data: ['small item'],
                usagePercentage: 90,
            });

            // tokenLimit = floor(modelMaxTokens * 0.9)
            const expectedLimit = Math.floor(modelMaxTokens * 0.9);
            expect(result.tokenLimit).toBe(expectedLimit);
            expect(result.totalChunks).toBe(1);
        });

        it('should use defaultMaxTokens when model is not provided', () => {
            const result = service.chunkDataByTokens({
                data: ['small item'],
                usagePercentage: 90,
                defaultMaxTokens: 50000,
            });

            const expectedLimit = Math.floor(50000 * 0.9);
            expect(result.tokenLimit).toBe(expectedLimit);
        });

        it('should use defaultMaxTokens when model is not found in strategies', () => {
            const result = service.chunkDataByTokens({
                model: 'unknown-model-xyz' as any,
                data: ['small item'],
                usagePercentage: 90,
                defaultMaxTokens: 30000,
            });

            const expectedLimit = Math.floor(30000 * 0.9);
            expect(result.tokenLimit).toBe(expectedLimit);
        });
    });

    // -----------------------------------------------------------------
    // With overrideMaxTokens
    // -----------------------------------------------------------------

    describe('with overrideMaxTokens', () => {
        it('should use overrideMaxTokens instead of model strategy', () => {
            const overrideValue = 20000;

            const result = service.chunkDataByTokens({
                model: LLMModelProvider.GEMINI_2_5_PRO,
                data: ['small item'],
                usagePercentage: 90,
                overrideMaxTokens: overrideValue,
            });

            // Should use overrideMaxTokens, NOT the model strategy (1M tokens)
            const expectedLimit = Math.floor(overrideValue * 0.9);
            expect(result.tokenLimit).toBe(expectedLimit);
        });

        it('should apply usagePercentage on top of overrideMaxTokens', () => {
            const result = service.chunkDataByTokens({
                model: LLMModelProvider.GEMINI_2_5_PRO,
                data: ['small item'],
                usagePercentage: 50,
                overrideMaxTokens: 10000,
            });

            // tokenLimit = floor(10000 * 0.5) = 5000
            expect(result.tokenLimit).toBe(5000);
        });

        it('should ignore defaultMaxTokens when overrideMaxTokens is set', () => {
            const result = service.chunkDataByTokens({
                data: ['small item'],
                usagePercentage: 90,
                defaultMaxTokens: 200000,
                overrideMaxTokens: 10000,
            });

            // Should use overrideMaxTokens (10000), NOT defaultMaxTokens (200000)
            const expectedLimit = Math.floor(10000 * 0.9);
            expect(result.tokenLimit).toBe(expectedLimit);
        });
    });

    // -----------------------------------------------------------------
    // overrideMaxTokens = 0 or falsy
    // -----------------------------------------------------------------

    describe('with overrideMaxTokens = 0 or falsy', () => {
        it('should fall back to model strategy when overrideMaxTokens is 0', () => {
            const modelMaxTokens =
                MODEL_STRATEGIES[LLMModelProvider.GEMINI_2_5_PRO]
                    .inputMaxTokens;

            const result = service.chunkDataByTokens({
                model: LLMModelProvider.GEMINI_2_5_PRO,
                data: ['small item'],
                usagePercentage: 90,
                overrideMaxTokens: 0,
            });

            const expectedLimit = Math.floor(modelMaxTokens * 0.9);
            expect(result.tokenLimit).toBe(expectedLimit);
        });

        it('should fall back to model strategy when overrideMaxTokens is undefined', () => {
            const modelMaxTokens =
                MODEL_STRATEGIES[LLMModelProvider.GEMINI_2_5_PRO]
                    .inputMaxTokens;

            const result = service.chunkDataByTokens({
                model: LLMModelProvider.GEMINI_2_5_PRO,
                data: ['small item'],
                usagePercentage: 90,
                overrideMaxTokens: undefined,
            });

            const expectedLimit = Math.floor(modelMaxTokens * 0.9);
            expect(result.tokenLimit).toBe(expectedLimit);
        });

        it('should fall back to defaultMaxTokens when overrideMaxTokens is 0 and no model', () => {
            const result = service.chunkDataByTokens({
                data: ['small item'],
                usagePercentage: 90,
                defaultMaxTokens: 40000,
                overrideMaxTokens: 0,
            });

            const expectedLimit = Math.floor(40000 * 0.9);
            expect(result.tokenLimit).toBe(expectedLimit);
        });
    });

    // -----------------------------------------------------------------
    // Chunking behavior with overrideMaxTokens
    // -----------------------------------------------------------------

    describe('chunking behavior with overrideMaxTokens', () => {
        it('should produce more chunks when overrideMaxTokens is smaller than model default', () => {
            // Each item ≈ 500 tokens (2000 chars / 4)
            const items = [
                generateItem(500, 'a'),
                generateItem(500, 'b'),
                generateItem(500, 'c'),
                generateItem(500, 'd'),
            ];
            // Total ≈ 2000 tokens

            // With model strategy (1M tokens) — everything fits in 1 chunk
            const resultDefault = service.chunkDataByTokens({
                model: LLMModelProvider.GEMINI_2_5_PRO,
                data: items,
                usagePercentage: 90,
            });

            // With overrideMaxTokens=800, tokenLimit = floor(800 * 0.9) = 720
            // Each item ≈ 500 tokens, so each item gets its own chunk
            const resultOverride = service.chunkDataByTokens({
                model: LLMModelProvider.GEMINI_2_5_PRO,
                data: items,
                usagePercentage: 90,
                overrideMaxTokens: 800,
            });

            expect(resultDefault.totalChunks).toBe(1);
            expect(resultOverride.totalChunks).toBeGreaterThan(1);
        });

        it('should produce fewer chunks when overrideMaxTokens is larger', () => {
            // Each item ≈ 500 tokens
            const items = [
                generateItem(500, 'a'),
                generateItem(500, 'b'),
                generateItem(500, 'c'),
                generateItem(500, 'd'),
            ];

            // With small override: tokenLimit = floor(800 * 0.9) = 720
            // Each item ≈ 500 > 720? No, 500 < 720. Two items = 1000 > 720.
            // So ~1 item per chunk = 4 chunks.
            const resultSmall = service.chunkDataByTokens({
                data: items,
                usagePercentage: 90,
                overrideMaxTokens: 800,
            });

            // With large override: tokenLimit = floor(5000 * 0.9) = 4500
            // All 4 items ≈ 2000 tokens < 4500, fits in 1 chunk
            const resultLarge = service.chunkDataByTokens({
                data: items,
                usagePercentage: 90,
                overrideMaxTokens: 5000,
            });

            expect(resultSmall.totalChunks).toBeGreaterThan(
                resultLarge.totalChunks,
            );
            expect(resultLarge.totalChunks).toBe(1);
        });

        it('should correctly split items across chunk boundaries', () => {
            // Each item ≈ 300 tokens (1200 chars / 4)
            const items = [
                generateItem(300, 'file1'),
                generateItem(300, 'file2'),
                generateItem(300, 'file3'),
            ];
            // Total ≈ 900 tokens

            // overrideMaxTokens = 700, usagePercentage = 90
            // tokenLimit = floor(700 * 0.9) = 630
            // First item: 300 < 630, add. Second: 300+300=600 < 630, add.
            // Third: 600+300=900 > 630, new chunk.
            // Result: 2 chunks — [file1, file2] and [file3]
            const result = service.chunkDataByTokens({
                data: items,
                usagePercentage: 90,
                overrideMaxTokens: 700,
            });

            expect(result.totalChunks).toBe(2);
            expect(result.chunks[0]).toHaveLength(2);
            expect(result.chunks[1]).toHaveLength(1);
        });
    });

    // -----------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------

    describe('edge cases with overrideMaxTokens', () => {
        it('should handle single item that exceeds overrideMaxTokens limit', () => {
            // Item ≈ 5000 tokens, overrideMaxTokens = 1000
            // tokenLimit = floor(1000 * 0.9) = 900
            // Item exceeds limit → placed alone in its own chunk
            const result = service.chunkDataByTokens({
                data: [generateItem(5000, 'huge')],
                usagePercentage: 90,
                overrideMaxTokens: 1000,
            });

            expect(result.totalChunks).toBe(1);
            expect(result.chunks[0]).toHaveLength(1);
        });

        it('should handle mix of items where some exceed the limit', () => {
            const items = [
                generateItem(100, 'small'),
                generateItem(5000, 'huge'),
                generateItem(100, 'small2'),
            ];

            // overrideMaxTokens = 1000, tokenLimit = 900
            // small(100) fits in current chunk
            // huge(5000) > 900 → finalize [small], push [huge] as solo chunk
            // small2(100) → new chunk [small2]
            const result = service.chunkDataByTokens({
                data: items,
                usagePercentage: 90,
                overrideMaxTokens: 1000,
            });

            expect(result.totalChunks).toBe(3);
            expect(result.chunks[0]).toHaveLength(1); // [small]
            expect(result.chunks[1]).toHaveLength(1); // [huge]
            expect(result.chunks[2]).toHaveLength(1); // [small2]
        });

        it('should handle negative overrideMaxTokens as not configured', () => {
            const modelMaxTokens =
                MODEL_STRATEGIES[LLMModelProvider.GEMINI_2_5_PRO]
                    .inputMaxTokens;

            const result = service.chunkDataByTokens({
                model: LLMModelProvider.GEMINI_2_5_PRO,
                data: ['small item'],
                usagePercentage: 90,
                overrideMaxTokens: -100,
            });

            // Negative → falls back to model strategy
            const expectedLimit = Math.floor(modelMaxTokens * 0.9);
            expect(result.tokenLimit).toBe(expectedLimit);
        });

        it('should handle object items with overrideMaxTokens', () => {
            // Each item serializes to ~2030 chars → ~507 tokens
            const items = [
                { filename: 'a.ts', patch: 'x'.repeat(2000) },
                { filename: 'b.ts', patch: 'y'.repeat(2000) },
                { filename: 'c.ts', patch: 'z'.repeat(2000) },
            ];

            // overrideMaxTokens = 700, tokenLimit = floor(700 * 0.9) = 630
            // Each item ≈ 507 tokens, two items ≈ 1014 > 630 → split
            const result = service.chunkDataByTokens({
                data: items,
                usagePercentage: 90,
                overrideMaxTokens: 700,
            });

            expect(result.totalChunks).toBe(3);
            expect(result.totalItems).toBe(3);
        });
    });
});
