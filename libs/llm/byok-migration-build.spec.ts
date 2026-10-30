/**
 * Post-migration BUILD smoke: the real guarantee that a migrated legacy blob
 * still WORKS. For every provider present in the production BYOK export, run the
 * full chain a review actually takes —
 *
 *   legacy {main,fallback}  →  migrateLegacyToV2  →  resolveModelSlot  →
 *   buildModelFromSlot (decrypts the ciphertext + constructs the SDK client)
 *
 * — and assert it builds a LanguageModel without throwing. Uses REAL encrypt()
 * keys (so decrypt() in the build path runs for real, unlike the redacted prod
 * dump), which also exercises the main↔fallback dedup decrypt path.
 */
import { encrypt } from '@libs/common/utils/crypto';
import { migrateLegacyToV2 } from './migrate-byok-config';
import { resolveModelSlot } from './resolve-model-slot';
import { buildModelFromSlot } from './byok-to-vercel';

// Minimal legacy slot per provider — the shapes measured in prod. apiKey is a
// real ciphertext; Bedrock carries a bearer token instead.
const PROVIDER_FIXTURES: Array<{
    provider: string;
    slot: Record<string, unknown>;
}> = [
    { provider: 'openai', slot: { provider: 'openai', apiKey: encrypt('sk-openai'), model: 'gpt-5.4' } },
    {
        provider: 'openai_compatible',
        slot: {
            provider: 'openai_compatible',
            apiKey: encrypt('sk-compat'),
            model: 'glm-5.2',
            baseURL: 'https://api.z.ai/v1',
        },
    },
    { provider: 'anthropic', slot: { provider: 'anthropic', apiKey: encrypt('sk-anthropic'), model: 'claude-sonnet-4-6' } },
    {
        provider: 'anthropic_compatible',
        slot: {
            provider: 'anthropic_compatible',
            apiKey: encrypt('sk-anthropic-compat'),
            model: 'kimi-k2.6',
            baseURL: 'https://api.moonshot.ai/anthropic',
        },
    },
    { provider: 'google_gemini', slot: { provider: 'google_gemini', apiKey: encrypt('sk-gemini'), model: 'gemini-3-flash-preview' } },
    {
        provider: 'open_router',
        slot: {
            provider: 'open_router',
            apiKey: encrypt('sk-or'),
            model: 'z-ai/glm-5.2',
            openrouterProviderOrder: ['novita', 'z-ai'],
            openrouterAllowFallbacks: false,
        },
    },
    { provider: 'novita', slot: { provider: 'novita', apiKey: encrypt('sk-novita'), model: 'deepseek/deepseek-v4-flash' } },
    {
        provider: 'amazon_bedrock',
        slot: {
            provider: 'amazon_bedrock',
            model: 'us.anthropic.claude-sonnet-4-6',
            awsBearerToken: encrypt('bedrock-bearer'),
            awsRegion: 'us-east-1',
        },
    },
];

describe('post-migration build smoke (all prod providers)', () => {
    it.each(PROVIDER_FIXTURES)(
        'migrates + builds a model for $provider',
        ({ slot }) => {
            const v2 = migrateLegacyToV2({ main: slot });
            const resolved = resolveModelSlot(v2, v2.routing?.defaultModelId);
            expect(resolved).toBeDefined();

            const model = buildModelFromSlot(resolved);
            expect(model).toBeDefined();
            expect(typeof model).toBe('object');
        },
    );

    it('folds main↔fallback with the SAME key into one credential (real decrypt)', () => {
        const key = encrypt('sk-shared'); // same plaintext, same ciphertext bytes
        const v2 = migrateLegacyToV2({
            main: { provider: 'openai', apiKey: key, model: 'gpt-5.4' },
            fallback: { provider: 'openai', apiKey: key, model: 'gpt-5.4-mini' },
        });
        // Same credential → deduped to ONE credential, but BOTH models kept.
        expect(v2.credentials).toHaveLength(1);
        expect(v2.models).toHaveLength(2);
        expect(v2.models[1].credentialId).toBe(v2.credentials[0].id);
    });

    it('keeps two credentials when the fallback uses a DIFFERENT key', () => {
        const v2 = migrateLegacyToV2({
            main: { provider: 'openai', apiKey: encrypt('sk-A'), model: 'gpt-5.4' },
            fallback: { provider: 'openai', apiKey: encrypt('sk-B'), model: 'gpt-5.4-mini' },
        });
        expect(v2.credentials).toHaveLength(2);
        expect(v2.models).toHaveLength(2);
    });

    it('builds BOTH slots of a migrated main+fallback config', () => {
        const v2 = migrateLegacyToV2({
            main: { provider: 'openai', apiKey: encrypt('sk-A'), model: 'gpt-5.4' },
            fallback: { provider: 'anthropic', apiKey: encrypt('sk-B'), model: 'claude-sonnet-4-6' },
        });
        const mainSlot = resolveModelSlot(v2, 'model-main');
        const fbSlot = resolveModelSlot(v2, 'model-fallback');
        expect(buildModelFromSlot(mainSlot)).toBeDefined();
        expect(buildModelFromSlot(fbSlot)).toBeDefined();
    });
});
