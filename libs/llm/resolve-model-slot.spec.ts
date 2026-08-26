import {
    resolveDefaultSlot,
    resolveModelSlot,
} from './resolve-model-slot';
import type { BYOKConfig } from './byok-config';

describe('resolveDefaultSlot — the effective default slot for a config', () => {
    it('resolves a config: model + credential → slot with the credential ciphertext', () => {
        const v2: BYOKConfig = {
            version: 2,
            credentials: [
                { id: 'c1', provider: 'openai_compatible', apiKey: 'enc-C1', settings: { baseURL: 'https://h:8000/v1' } },
            ],
            models: [{ id: 'm1', credentialId: 'c1', model: 'kimi-k2.7-code' }],
        };
        expect(resolveDefaultSlot(v2)).toMatchObject({
            provider: 'openai_compatible',
            model: 'kimi-k2.7-code',
            baseURL: 'https://h:8000/v1',
            apiKey: 'enc-C1', // ciphertext from the credential, not decrypted
        });
    });

    it('honors routing.defaultModelId; falls back to the first model when unset', () => {
        const v2: BYOKConfig = {
            version: 2,
            credentials: [
                { id: 'c1', provider: 'openai', apiKey: 'enc-1' },
                { id: 'c2', provider: 'anthropic', apiKey: 'enc-2' },
            ],
            models: [
                { id: 'm1', credentialId: 'c1', model: 'gpt-4o' },
                { id: 'm2', credentialId: 'c2', model: 'claude-sonnet-4-6' },
            ],
            routing: { defaultModelId: 'm2' },
        };
        expect(resolveDefaultSlot(v2)?.model).toBe('claude-sonnet-4-6');
        // No default → first model.
        expect(resolveDefaultSlot({ ...v2, routing: undefined })?.model).toBe(
            'gpt-4o',
        );
    });

    it('managed:true credential → null (env-default branch runs)', () => {
        const v2: BYOKConfig = {
            version: 2,
            credentials: [{ id: 'mgd', provider: 'openai_compatible', managed: true }],
            models: [{ id: 'm1', credentialId: 'mgd', model: 'kimi-k2.7-code' }],
        };
        expect(resolveDefaultSlot(v2)).toBeUndefined();
    });

    it('degrades (does not throw) on an unknown/credential-less model → null', () => {
        const v2: BYOKConfig = {
            version: 2,
            credentials: [],
            models: [{ id: 'm1', credentialId: 'missing', model: 'gpt-4o' }],
        };
        expect(() => resolveDefaultSlot(v2)).not.toThrow();
        expect(resolveDefaultSlot(v2)).toBeUndefined();
    });

    it('empty / undefined / malformed / non-v2 → null (env default), never throws', () => {
        expect(resolveDefaultSlot(undefined)).toBeUndefined();
        expect(resolveDefaultSlot(null)).toBeUndefined();
        expect(resolveDefaultSlot('garbage')).toBeUndefined();
        expect(resolveDefaultSlot({ version: 2 })).toBeUndefined();
        expect(resolveDefaultSlot({ version: 1, main: {} } as any)).toBeUndefined();
        expect(() => resolveDefaultSlot({ main: 42, fallback: [] } as any)).not.toThrow();
        expect(resolveDefaultSlot({ main: 42, fallback: [] } as any)).toBeUndefined();
    });
});

describe('resolveModelSlot — materialize ONE v2 model slot by id (04b)', () => {
    const v2: BYOKConfig = {
        version: 2,
        credentials: [
            { id: 'c1', provider: 'openai_compatible', apiKey: 'enc-C1', settings: { baseURL: 'https://h/v1' } },
            { id: 'mgd', provider: 'openai', managed: true },
        ],
        models: [
            { id: 'm1', credentialId: 'c1', model: 'kimi-k2.7-code' },
            { id: 'm-managed', credentialId: 'mgd', model: 'gpt-4o' },
        ],
    };

    it('materializes the slot for a known model id with ciphertext intact', () => {
        const slot = resolveModelSlot(v2, 'm1');
        expect(slot).toMatchObject({
            provider: 'openai_compatible',
            model: 'kimi-k2.7-code',
            baseURL: 'https://h/v1',
            apiKey: 'enc-C1', // ciphertext — not decrypted
        });
    });

    it('returns null for an absent / unknown / managed model id', () => {
        expect(resolveModelSlot(v2, null)).toBeUndefined();
        expect(resolveModelSlot(v2, undefined)).toBeUndefined();
        expect(resolveModelSlot(v2, 'nope')).toBeUndefined();
        expect(resolveModelSlot(v2, 'm-managed')).toBeUndefined();
    });
});

describe('resolveModelSlot — Amazon Bedrock authenticates with aws* fields, NOT apiKey', () => {
    // Regression: Bedrock credentials carry NO `apiKey` (they use awsBearerToken or
    // a SigV4 IAM pair). Requiring `apiKey` silently degraded every Bedrock slot to
    // the managed default — a review configured for Bedrock ran on DeepSeek instead,
    // with no error, because the routing verdict still named the model.
    const bedrockCfg = (settings: Record<string, unknown>): BYOKConfig => ({
        version: 2,
        credentials: [{ id: 'b', provider: 'amazon_bedrock', settings }],
        models: [
            {
                id: 'mb',
                credentialId: 'b',
                model: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
            },
        ],
    });

    it('resolves a slot from awsBearerToken (no apiKey)', () => {
        const slot = resolveModelSlot(
            bedrockCfg({ awsBearerToken: 'enc-bearer', awsRegion: 'us-east-1' }),
            'mb',
        );
        expect(slot).toMatchObject({
            provider: 'amazon_bedrock',
            model: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
            awsBearerToken: 'enc-bearer',
            awsRegion: 'us-east-1',
        });
        // No apiKey on the credential → empty ciphertext (decrypt('') is a no-op).
        expect(slot?.apiKey).toBe('');
    });

    it('resolves a slot from a SigV4 IAM pair (no apiKey)', () => {
        const slot = resolveModelSlot(
            bedrockCfg({
                awsAccessKeyId: 'enc-akid',
                awsSecretAccessKey: 'enc-secret',
                awsRegion: 'us-east-1',
            }),
            'mb',
        );
        expect(slot?.provider).toBe('amazon_bedrock');
        expect(slot?.awsAccessKeyId).toBe('enc-akid');
    });

    it('degrades to null when NO auth material is present (no apiKey, no aws*)', () => {
        expect(
            resolveModelSlot(bedrockCfg({ awsRegion: 'us-east-1' }), 'mb'),
        ).toBeUndefined();
        // A lone access key id without its secret is not a usable IAM pair.
        expect(
            resolveModelSlot(bedrockCfg({ awsAccessKeyId: 'enc-akid' }), 'mb'),
        ).toBeUndefined();
    });
});
