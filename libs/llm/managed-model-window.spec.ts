/**
 * Unit tests for managedModelMaxInputTokens — the seam that replaced the old
 * MODEL_INPUT_MAX_TOKENS table.
 *
 * The window no longer comes from the provider registry. It comes from the model
 * layer, which is the SAME source the BYOK review path reads: a provider module
 * describes transport, it does not define what a model is. Reading it off the
 * registry meant three hand-typed entries answering for a whole catalog, so
 * almost every managed model resolved to `undefined` and chunked at the caller's
 * 64k default — including models that hold a million tokens.
 */
import { managedModelMaxInputTokens } from './managed-model-window';
import { LLMModelProvider } from './model-providers';

describe('managedModelMaxInputTokens', () => {
    it('resolves the managed Gemini window, stripping our vendor prefix', () => {
        // 1,048,576 — the vendor's own number. The registry said 1,000,000,
        // hand-typed and already stale, and the BYOK path had the right one all
        // along. That disagreement is what this change removes.
        expect(
            managedModelMaxInputTokens(LLMModelProvider.GEMINI_2_5_PRO),
        ).toBe(1_048_576);
        expect(managedModelMaxInputTokens('google:gemini-2.5-pro')).toBe(
            1_048_576,
        );
    });

    it('resolves the Gemini 3.1 flash-lite window', () => {
        expect(
            managedModelMaxInputTokens(
                LLMModelProvider.GEMINI_3_1_FLASH_LITE_PREVIEW,
            ),
        ).toBe(1_048_576);
    });

    it('resolves the legacy Claude-on-Vertex window (vertex → google_vertex)', () => {
        expect(
            managedModelMaxInputTokens(
                LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET,
            ),
        ).toBe(200_000);
    });

    it('a model nobody had pinned still has a real window', () => {
        // gemini-2.0-flash was `undefined` here — not because it lacks a window,
        // but because nobody had typed it into the registry. It holds 1,048,576,
        // and the managed chunker was budgeting 64k for it.
        expect(
            managedModelMaxInputTokens(LLMModelProvider.GEMINI_2_0_FLASH),
        ).toBe(1_048_576);
    });

    it('returns undefined only when the model is genuinely unknown', () => {
        // The `undefined` contract still matters — the caller substitutes its own
        // budget — it just has to mean "we do not know this model" rather than
        // "nobody filled in the table".
        expect(
            managedModelMaxInputTokens('google:not-a-real-model-xyz'),
        ).toBeUndefined();
    });

    it('returns undefined for a bare BYOK model string (no vendor prefix)', () => {
        expect(managedModelMaxInputTokens('gpt-4o')).toBeUndefined();
        expect(
            managedModelMaxInputTokens(
                'accounts/fireworks/models/deepseek-v4-flash-0731',
            ),
        ).toBeUndefined();
    });

    it('returns undefined for an unknown vendor prefix or empty input', () => {
        expect(managedModelMaxInputTokens('unknown:some-model')).toBeUndefined();
        expect(managedModelMaxInputTokens('')).toBeUndefined();
        expect(managedModelMaxInputTokens(undefined)).toBeUndefined();
    });
});
