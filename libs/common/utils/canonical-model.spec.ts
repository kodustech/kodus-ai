import { canonicalModelId } from './canonical-model';

describe('canonicalModelId', () => {
    it('strips a leading provider: prefix', () => {
        expect(canonicalModelId('anthropic:claude-opus-5')).toBe(
            'claude-opus-5',
        );
        expect(canonicalModelId('google_gemini:gemini-2.5-pro')).toBe(
            'gemini-2.5-pro',
        );
    });

    it('strips a Bedrock :<version> suffix instead of returning the version', () => {
        // Regression: the old split(':').pop() returned "0" here — which never
        // matched the configured id AND collapsed every Bedrock model onto "0".
        expect(
            canonicalModelId('us.anthropic.claude-3-5-haiku-20241022-v1:0'),
        ).toBe('us.anthropic.claude-3-5-haiku-20241022-v1');
    });

    it('canonicalizes the versioned and unversioned Bedrock id to the SAME value (so the cost join matches)', () => {
        expect(
            canonicalModelId('us.anthropic.claude-3-5-haiku-20241022-v1:0'),
        ).toBe(canonicalModelId('us.anthropic.claude-3-5-haiku-20241022-v1'));
    });

    it('keeps DISTINCT Bedrock models distinct (no "0" collision)', () => {
        const haiku = canonicalModelId(
            'us.anthropic.claude-3-5-haiku-20241022-v1:0',
        );
        const sonnet = canonicalModelId(
            'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        );
        expect(haiku).not.toBe(sonnet);
    });

    it('preserves a provider/ slash prefix (the read path emits the bare form separately)', () => {
        expect(canonicalModelId('vertex_ai/gemini-2.5-pro')).toBe(
            'vertex_ai/gemini-2.5-pro',
        );
    });

    it('leaves a plain id untouched and handles empty/nullish', () => {
        expect(canonicalModelId('gpt-4o-2024-08-06')).toBe('gpt-4o-2024-08-06');
        expect(canonicalModelId('')).toBe('');
        expect(canonicalModelId(null)).toBe('');
        expect(canonicalModelId(undefined)).toBe('');
    });
});
