import { isOpenCodeGoBaseUrl, openCodeSessionId } from './opencode-go';
import PROD_SHAPES from './testing/__fixtures__/byok-prod-shapes.json';

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

    it('is anchored to the actual host, not a substring anywhere in the URL', () => {
        // A prior version was a bare `/opencode\.ai\/zen/i.test(baseURL)`
        // substring scan — these two would have matched it, attaching the
        // header to an upstream that is not OpenCode Go at all.
        expect(isOpenCodeGoBaseUrl('https://notopencode.ai/zen/v1')).toBe(
            false,
        );
        expect(
            isOpenCodeGoBaseUrl(
                'https://gw.corp.example/opencode.ai/zen/v1',
            ),
        ).toBe(false);
        // Same host, unrelated path — still no match.
        expect(isOpenCodeGoBaseUrl('https://opencode.ai/other')).toBe(false);
        // A malformed / non-absolute baseURL degrades to false, not a throw.
        expect(isOpenCodeGoBaseUrl('not a url')).toBe(false);
    });

    it('matches bare opencode.ai/zen/v1 too (no "/go" segment) — a real shape in production, not just the documented /zen/go/v1 form', () => {
        // libs/llm/testing/__fixtures__/byok-prod-shapes.json has live orgs on
        // exactly this bare shape (kimi-k2.5, minimax-m3-free) alongside the
        // /zen/go/v1 ones — a prior commit narrowed the match to require
        // "/go" and would have silently dropped the header for these.
        expect(isOpenCodeGoBaseUrl('https://opencode.ai/zen/v1')).toBe(true);
    });

    it('matches EVERY real opencode.ai baseURL shape in the production corpus — a regression guard against re-narrowing the match', () => {
        const opencodeShapes = (
            PROD_SHAPES as Array<{ baseURL?: string }>
        ).filter((shape) => shape.baseURL?.includes('opencode.ai'));

        // Fails loud if the fixture ever stops carrying an opencode.ai shape —
        // a passing-by-vacuity corpus test is worse than no test at all.
        expect(opencodeShapes.length).toBeGreaterThan(0);

        for (const shape of opencodeShapes) {
            expect(isOpenCodeGoBaseUrl(shape.baseURL)).toBe(true);
        }
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
