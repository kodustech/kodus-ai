/**
 * Unit tests for managedModelMaxInputTokens — the seam that replaced the old
 * MODEL_INPUT_MAX_TOKENS table. Proves the per-model window now comes from the
 * provider registry's capabilities, resolved from an LLMModelProvider enum value.
 */
import { managedModelMaxInputTokens } from './managed-model-window';
import { LLMModelProvider } from './model-providers';

describe('managedModelMaxInputTokens', () => {
    it('resolves the managed Gemini window from the registry (google → google_gemini)', () => {
        expect(
            managedModelMaxInputTokens(LLMModelProvider.GEMINI_2_5_PRO),
        ).toBe(1_000_000);
        expect(managedModelMaxInputTokens('google:gemini-2.5-pro')).toBe(
            1_000_000,
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

    it('returns undefined for a managed model with no pinned window', () => {
        expect(
            managedModelMaxInputTokens(LLMModelProvider.GEMINI_2_0_FLASH),
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
