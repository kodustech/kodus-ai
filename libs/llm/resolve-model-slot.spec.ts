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
        expect(resolveDefaultSlot(v2)).toBeNull();
    });

    it('degrades (does not throw) on an unknown/credential-less model → null', () => {
        const v2: BYOKConfig = {
            version: 2,
            credentials: [],
            models: [{ id: 'm1', credentialId: 'missing', model: 'gpt-4o' }],
        };
        expect(() => resolveDefaultSlot(v2)).not.toThrow();
        expect(resolveDefaultSlot(v2)).toBeNull();
    });

    it('empty / undefined / malformed / non-v2 → null (env default), never throws', () => {
        expect(resolveDefaultSlot(undefined)).toBeNull();
        expect(resolveDefaultSlot(null)).toBeNull();
        expect(resolveDefaultSlot('garbage')).toBeNull();
        expect(resolveDefaultSlot({ version: 2 })).toBeNull();
        expect(resolveDefaultSlot({ version: 1, main: {} } as any)).toBeNull();
        expect(() => resolveDefaultSlot({ main: 42, fallback: [] } as any)).not.toThrow();
        expect(resolveDefaultSlot({ main: 42, fallback: [] } as any)).toBeNull();
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
        expect(resolveModelSlot(v2, null)).toBeNull();
        expect(resolveModelSlot(v2, undefined)).toBeNull();
        expect(resolveModelSlot(v2, 'nope')).toBeNull();
        expect(resolveModelSlot(v2, 'm-managed')).toBeNull();
    });
});
