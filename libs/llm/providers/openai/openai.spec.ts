/**
 * openai module — structured-output capability (never-downgrade) and the
 * OpenCode Go session header. Usage normalization is shared by every module and
 * proven once in kernel/conformance.spec.ts + kernel/registry.spec.ts.
 */
import { openaiModule } from './index';

// A minimal build config; apiKey/baseURL are never dialed.
const openaiCompatibleCfg = {
    provider: 'openai_compatible',
    model: 'kimi-k2.7-code',
    apiKey: 'test-key',
    baseURL: 'https://api.moonshot.ai/v1',
} as any;

describe('openaiModule never-downgrade capability (D-00b, Pitfall 2)', () => {
    // A direct-Moonshot BYOK config: openai_compatible + api.moonshot.ai baseURL,
    // which shouldEnableJsonSchema alone would REJECT (not :8000, not allow-listed).
    const moonshotCfg = {
        provider: 'openai_compatible',
        model: 'kimi-k2.7-code',
        apiKey: 'test-key',
        baseURL: 'https://api.moonshot.ai/v1',
    } as any;

    // An unknown openai_compatible upstream with no allow-listed baseURL — must
    // still defer to shouldEnableJsonSchema (i.e. stay OFF), proving the override
    // is additive, not a blanket force-on.
    const unknownCfg = {
        provider: 'openai_compatible',
        model: 'llama-3.1-70b-instruct',
        apiKey: 'test-key',
        baseURL: 'https://my-unknown-proxy.example.com/v1',
    } as any;

    it('Kimi/Moonshot openai_compatible build keeps json_schema ON despite api.moonshot.ai baseURL', () => {
        const model = openaiModule.build(moonshotCfg, {
            structuredOutputs: true,
        }) as any;
        expect(model.supportsStructuredOutputs).toBe(true);
    });

    it('unknown openai_compatible upstream still defers to the baseURL gate (stays OFF)', () => {
        const model = openaiModule.build(unknownCfg, {
            structuredOutputs: true,
        }) as any;
        expect(model.supportsStructuredOutputs).toBe(false);
    });

    it('the override is opt-in only: no structuredOutputs opt-in → OFF even for Kimi', () => {
        const model = openaiModule.build(moonshotCfg, {
            structuredOutputs: false,
        }) as any;
        expect(model.supportsStructuredOutputs).toBe(false);
    });

    it("capabilities(kimiId).structuredOutput === 'json_schema' (declared never-downgrade signal)", () => {
        expect(openaiModule.capabilities('kimi-k2.7-code').structuredOutput).toBe(
            'json_schema',
        );
        expect(
            openaiModule.capabilities('moonshotai/kimi-k2-instruct')
                .structuredOutput,
        ).toBe('json_schema');
    });

    it("capabilities(unknownCompatibleId).structuredOutput is NOT json_schema (only known families claim it)", () => {
        expect(
            openaiModule.capabilities('llama-3.1-70b-instruct').structuredOutput,
        ).not.toBe('json_schema');
    });
});

describe('openaiModule x-opencode-session header (issue #1880)', () => {
    const HEX32 = /^[0-9a-f]{32}$/;

    it('opencode.ai/zen baseURL gets a hashed, stable x-opencode-session header — never the raw byokModelId', () => {
        const cfg = {
            provider: 'openai_compatible',
            model: 'deepseek-v4-flash',
            apiKey: 'test-key',
            baseURL: 'https://opencode.ai/zen/go/v1',
            byokModelId: 'model-123',
        } as any;

        const headerA = (openaiModule.build(cfg) as any).config.headers()[
            'x-opencode-session'
        ];
        const headerB = (openaiModule.build(cfg) as any).config.headers()[
            'x-opencode-session'
        ];

        expect(headerA).toMatch(HEX32);
        expect(headerA).not.toBe('model-123');
        expect(headerA).not.toContain('model-123');
        // Stable across independent build() calls for the same slot.
        expect(headerA).toBe(headerB);
    });

    it('a different byokModelId hashes to a different session id', () => {
        const build = (byokModelId: string) =>
            (
                openaiModule.build({
                    provider: 'openai_compatible',
                    model: 'deepseek-v4-flash',
                    apiKey: 'test-key',
                    baseURL: 'https://opencode.ai/zen/go/v1',
                    byokModelId,
                } as any) as any
            ).config.headers()['x-opencode-session'];

        expect(build('model-123')).not.toBe(build('model-456'));
    });

    it('falls back to credentialId when no byokModelId is present — two orgs sharing model+baseURL never collide, and never the raw credentialId', () => {
        const buildFallback = (credentialId: string) =>
            (
                openaiModule.build({
                    provider: 'openai_compatible',
                    model: 'deepseek-v4-flash',
                    apiKey: 'test-key',
                    baseURL: 'https://opencode.ai/zen/go/v1',
                    credentialId,
                } as any) as any
            ).config.headers()['x-opencode-session'];

        // Different org (different credential) → different session id, even
        // though model + baseURL are identical (the OpenCode Go norm).
        expect(buildFallback('cred-a')).not.toBe(buildFallback('cred-b'));

        // Same org's credential → the SAME id every time (persisted, not
        // process state).
        expect(buildFallback('cred-a')).toBe(buildFallback('cred-a'));
        expect(buildFallback('cred-a')).toMatch(HEX32);
        expect(buildFallback('cred-a')).not.toBe('cred-a');
        expect(buildFallback('cred-a')).not.toContain('cred-a');
    });

    describe('last-resort fallback (neither byokModelId nor credentialId — self-hosted env/managed slot)', () => {
        const buildNeither = () =>
            (
                openaiModule.build({
                    provider: 'openai_compatible',
                    model: 'deepseek-v4-flash',
                    apiKey: 'test-key',
                    baseURL: 'https://opencode.ai/zen/go/v1',
                } as any) as any
            ).config.headers()['x-opencode-session'];

        const originalCryptoKey = process.env.API_CRYPTO_KEY;
        afterEach(() => {
            process.env.API_CRYPTO_KEY = originalCryptoKey;
        });

        it('is HMAC-derived (hashed, distinct from a config carrying credentialId)', () => {
            const withNeither = buildNeither();
            expect(withNeither).toMatch(HEX32);

            const withCredentialId = (
                openaiModule.build({
                    provider: 'openai_compatible',
                    model: 'deepseek-v4-flash',
                    apiKey: 'test-key',
                    baseURL: 'https://opencode.ai/zen/go/v1',
                    credentialId: 'cred-456',
                } as any) as any
            ).config.headers()['x-opencode-session'];
            expect(withNeither).not.toBe(withCredentialId);
        });

        it('is stable across builds for the same deployment (same API_CRYPTO_KEY)', () => {
            process.env.API_CRYPTO_KEY = 'deployment-a-key';
            expect(buildNeither()).toBe(buildNeither());
        });

        it('differs across deployments (different API_CRYPTO_KEY) even with identical model+baseURL — the collision two prior review rounds flagged', () => {
            process.env.API_CRYPTO_KEY = 'deployment-a-key';
            const deploymentA = buildNeither();

            process.env.API_CRYPTO_KEY = 'deployment-b-key';
            const deploymentB = buildNeither();

            expect(deploymentA).not.toBe(deploymentB);
        });
    });

    it('a non-OpenCode openai_compatible upstream never gets the header', () => {
        const model = openaiModule.build(openaiCompatibleCfg) as any;
        expect(model.config.headers()).not.toHaveProperty('x-opencode-session');
    });

    it('the native openai branch (provider "openai") gets the header too when pointed at opencode.ai/zen — it also accepts a baseURL override', () => {
        const model = openaiModule.build({
            provider: 'openai',
            model: 'gpt-4o-mini',
            apiKey: 'test-key',
            baseURL: 'https://opencode.ai/zen/go/v1',
            byokModelId: 'model-123',
        } as any) as any;

        expect(model.config.headers()['x-opencode-session']).toMatch(HEX32);
    });

    it('the native openai branch does NOT get the header for non-OpenCode baseURLs (default and Azure/proxy overrides)', () => {
        for (const baseURL of [
            undefined,
            'https://api.openai.com/v1',
            'https://my-proxy.example/openai',
        ]) {
            const model = openaiModule.build({
                provider: 'openai',
                model: 'gpt-4o-mini',
                apiKey: 'test-key',
                ...(baseURL ? { baseURL } : {}),
                byokModelId: 'model-123',
            } as any) as any;

            expect(model.config.headers()).not.toHaveProperty(
                'x-opencode-session',
            );
        }
    });
});

