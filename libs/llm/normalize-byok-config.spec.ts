import {
    normalizeByokConfig,
    resolveModelSlotFromV2,
} from './normalize-byok-config';
import type { BYOKConfigV2 } from './byok-config';

describe('normalizeByokConfig — v2-only (04b-06, dual-read dropped)', () => {
    it('resolves a v2 config: model + credential → main with the credential ciphertext', () => {
        const v2: BYOKConfigV2 = {
            version: 2,
            credentials: [
                { id: 'c1', provider: 'openai_compatible', apiKey: 'enc-C1', settings: { baseURL: 'https://h:8000/v1' } },
            ],
            models: [{ id: 'm1', credentialId: 'c1', model: 'kimi-k2.7-code' }],
        };
        const n = normalizeByokConfig(v2);
        expect(n.main).toMatchObject({
            provider: 'openai_compatible',
            model: 'kimi-k2.7-code',
            baseURL: 'https://h:8000/v1',
            apiKey: 'enc-C1', // ciphertext from the credential, not decrypted
        });
    });

    it('honors routing.defaultModelId for main; the next model becomes fallback', () => {
        const v2: BYOKConfigV2 = {
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
        const n = normalizeByokConfig(v2);
        expect(n.main?.model).toBe('claude-sonnet-4-6');
        expect(n.fallback?.model).toBe('gpt-4o');
    });

    it('managed:true credential → absent main (env-default branch runs)', () => {
        const v2: BYOKConfigV2 = {
            version: 2,
            credentials: [{ id: 'mgd', provider: 'openai_compatible', managed: true }],
            models: [{ id: 'm1', credentialId: 'mgd', model: 'kimi-k2.7-code' }],
        };
        expect(normalizeByokConfig(v2).main).toBeUndefined();
    });

    it('degrades (does not throw) on an unknown/credential-less model', () => {
        const v2: BYOKConfigV2 = {
            version: 2,
            credentials: [],
            models: [{ id: 'm1', credentialId: 'missing', model: 'gpt-4o' }],
        };
        expect(() => normalizeByokConfig(v2)).not.toThrow();
        expect(normalizeByokConfig(v2).main).toBeUndefined();
    });

    // The dual-read is GONE (04b-06): a stored legacy {main,fallback} blob is NO
    // LONGER read as a config shape. It falls through to `{}` → the env/managed
    // default downstream, exactly like an absent config. This is what makes the
    // self-host env-only + managed/no-BYOK paths keep resolving a model.
    it('a legacy {main,fallback} blob → {} (env default), NOT read as a stored shape', () => {
        const legacy = {
            main: { provider: 'openai', apiKey: 'enc-MAIN', model: 'gpt-4o', baseURL: 'https://x' },
            fallback: { provider: 'anthropic', apiKey: 'enc-FB', model: 'claude-sonnet-4-6' },
        };
        expect(normalizeByokConfig(legacy)).toEqual({});
    });

    it('empty / undefined / malformed / non-v2 → {} (env default), never throws', () => {
        expect(normalizeByokConfig(undefined)).toEqual({});
        expect(normalizeByokConfig(null)).toEqual({});
        expect(normalizeByokConfig('garbage')).toEqual({});
        expect(normalizeByokConfig({ version: 2 })).toEqual({});
        expect(normalizeByokConfig({ version: 1, main: {} } as any)).toEqual({});
        expect(() => normalizeByokConfig({ main: 42, fallback: [] } as any)).not.toThrow();
        expect(normalizeByokConfig({ main: 42, fallback: [] } as any)).toEqual({});
    });
});

describe('resolveModelSlotFromV2 — materialize ONE v2 model slot by id (04b)', () => {
    const v2: BYOKConfigV2 = {
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
        const slot = resolveModelSlotFromV2(v2, 'm1');
        expect(slot).toMatchObject({
            provider: 'openai_compatible',
            model: 'kimi-k2.7-code',
            baseURL: 'https://h/v1',
            apiKey: 'enc-C1', // ciphertext — not decrypted
        });
    });

    it('returns null for an absent / unknown / managed model id', () => {
        expect(resolveModelSlotFromV2(v2, null)).toBeNull();
        expect(resolveModelSlotFromV2(v2, undefined)).toBeNull();
        expect(resolveModelSlotFromV2(v2, 'nope')).toBeNull();
        expect(resolveModelSlotFromV2(v2, 'm-managed')).toBeNull();
    });
});
