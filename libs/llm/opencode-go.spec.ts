import { isOpenCodeGoBaseUrl, openCodeSessionId } from './opencode-go';

const HEX32 = /^[0-9a-f]{32}$/;

describe('isOpenCodeGoBaseUrl', () => {
    it('matches any opencode.ai/zen endpoint (chat completions, responses, or messages)', () => {
        expect(isOpenCodeGoBaseUrl('https://opencode.ai/zen/go/v1')).toBe(
            true,
        );
        expect(
            isOpenCodeGoBaseUrl('https://opencode.ai/zen/go/v1/chat/completions'),
        ).toBe(true);
        expect(isOpenCodeGoBaseUrl('https://opencode.ai/zen/go')).toBe(true);
    });

    it('does not match an unrelated or missing baseURL', () => {
        expect(isOpenCodeGoBaseUrl('https://api.openai.com/v1')).toBe(false);
        expect(isOpenCodeGoBaseUrl('https://opencode.ai/docs')).toBe(false);
        expect(isOpenCodeGoBaseUrl(undefined)).toBe(false);
    });
});

describe('openCodeSessionId', () => {
    it('prefers byokModelId, hashed (never sent raw)', () => {
        const id = openCodeSessionId({
            model: 'deepseek-v4-flash',
            baseURL: 'https://opencode.ai/zen/go/v1',
            byokModelId: 'model-123',
            credentialId: 'cred-456',
        });
        expect(id).toMatch(HEX32);
        expect(id).not.toContain('model-123');
    });

    it('falls back to credentialId when byokModelId is absent — different credentials never collide', () => {
        const build = (credentialId: string) =>
            openCodeSessionId({
                model: 'deepseek-v4-flash',
                baseURL: 'https://opencode.ai/zen/go/v1',
                credentialId,
            });

        expect(build('cred-a')).not.toBe(build('cred-b'));
        expect(build('cred-a')).toBe(build('cred-a'));
        expect(build('cred-a')).toMatch(HEX32);
    });

    describe('last-resort HMAC fallback (neither byokModelId nor credentialId)', () => {
        const originalCryptoKey = process.env.API_CRYPTO_KEY;
        afterEach(() => {
            process.env.API_CRYPTO_KEY = originalCryptoKey;
        });

        it('is stable for the same deployment and differs across deployments', () => {
            const build = () =>
                openCodeSessionId({
                    model: 'deepseek-v4-flash',
                    baseURL: 'https://opencode.ai/zen/go/v1',
                });

            process.env.API_CRYPTO_KEY = 'deployment-a-key';
            const a1 = build();
            const a2 = build();
            expect(a1).toBe(a2);
            expect(a1).toMatch(HEX32);

            process.env.API_CRYPTO_KEY = 'deployment-b-key';
            expect(build()).not.toBe(a1);
        });

        it('throws rather than silently deriving a shared, cross-deployment key when API_CRYPTO_KEY is unset', () => {
            delete process.env.API_CRYPTO_KEY;
            expect(() =>
                openCodeSessionId({
                    model: 'deepseek-v4-flash',
                    baseURL: 'https://opencode.ai/zen/go/v1',
                }),
            ).toThrow(/API_CRYPTO_KEY/);
        });
    });
});
