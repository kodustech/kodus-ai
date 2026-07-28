import { normalizeByokConfig } from './normalize-byok-config';
import type { BYOKConfigV2 } from './byok-config';

describe('normalizeByokConfig — dual-read (Phase 2, 02-01)', () => {
    it('passes a legacy {main,fallback} config through with ciphertext intact', () => {
        const legacy = {
            main: { provider: 'openai', apiKey: 'enc-MAIN', model: 'gpt-4o', baseURL: 'https://x' },
            fallback: { provider: 'anthropic', apiKey: 'enc-FB', model: 'claude-sonnet-4-6' },
        };
        const n = normalizeByokConfig(legacy);
        expect(n.main).toMatchObject({ provider: 'openai', model: 'gpt-4o', baseURL: 'https://x' });
        // NEVER decrypted — the exact ciphertext we passed in is preserved.
        expect(n.main?.apiKey).toBe('enc-MAIN');
        expect(n.fallback?.apiKey).toBe('enc-FB');
    });

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

    it('empty / undefined / malformed → {} (managed default), never throws', () => {
        expect(normalizeByokConfig(undefined)).toEqual({});
        expect(normalizeByokConfig(null)).toEqual({});
        expect(normalizeByokConfig('garbage')).toEqual({});
        expect(normalizeByokConfig({ version: 2 })).toEqual({});
        expect(() => normalizeByokConfig({ main: 42, fallback: [] } as any)).not.toThrow();
    });
});
