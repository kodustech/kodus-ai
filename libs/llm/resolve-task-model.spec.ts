/**
 * resolve-task-model.spec.ts — the SINGLE task→model resolution entry point
 * (slice 04b, plan 04b-01, TRACER).
 *
 * Proves:
 *  - v2 verdict parity: the returned model's slot id == StaticTaskStrategy's
 *    verdict.modelId; modelName == `${slot.provider}:${slot.model}`.
 *  - id override + legacy NAME override (id-THEN-name onto the resolved slot).
 *  - no-BYOK (config null) and BLOCKED verdict both degrade to the env/managed
 *    default model via `buildModelFromSlot`'s null-slot branch (never throws).
 *  - self-host env-only (no config, `API_LLM_PROVIDER_MODEL` set) still yields a
 *    model.
 *  - secret hygiene: the returned slot carries CIPHERTEXT; decrypt() runs only in
 *    buildModelFromSlot's local scope; no plaintext key surfaces in any returned
 *    field or in any console log.
 *
 * Seam strategy: mock the provider REGISTRY so a fake `build()` returns a sentinel
 * model and `capabilities()` makes codeReview eligible; mock the two env-branch
 * SDK factories so the null-slot path returns a sentinel without a network call;
 * mock `decrypt` so plaintext is a recognizable marker we can grep for.
 */

// Fake provider registry: build() returns a sentinel tagged with what it received
// (so we can prove decrypt happened in buildModelFromSlot's local scope), and
// capabilities() reports structured output so codeReview is eligible.
const registryBuild = jest.fn((cfg: any) => ({
    __sentinel: 'registry',
    provider: cfg.provider,
    modelId: cfg.model,
    receivedApiKey: cfg.apiKey,
}));
jest.mock('@libs/llm/providers', () => ({
    REGISTRY: {
        has: (_p: string) => true,
        get: (_p: string) => ({
            build: registryBuild,
            capabilities: (_model: string) => ({
                structuredOutput: 'json_schema',
                toolCalling: 'native',
            }),
        }),
    },
}));

// decrypt is a recognizable transform: ciphertext 'enc-x' → 'PLAINTEXT-enc-x'.
// Lets the log-spy assert the plaintext marker never leaks.
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => `PLAINTEXT-${v}`,
}));

// Env-branch SDK factories (null-slot path). Tag their return so we can assert a
// model was produced without a real provider call.
jest.mock('@ai-sdk/google', () => ({
    createGoogleGenerativeAI: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            __sentinel: 'env-google',
            modelId,
            settings,
        })),
    ),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            __sentinel: 'env-openai-compatible',
            modelId,
            settings,
        })),
    ),
}));

import { resolveTaskModel } from './resolve-task-model';

// openai gpt-* → structuredOutput json_schema (eligible for codeReview).
const v2 = (routing: any, models?: any[], credentials?: any[]) => ({
    version: 2 as const,
    credentials: credentials ?? [
        { id: 'c-oa', provider: 'openai', apiKey: 'enc-oa' },
    ],
    models: models ?? [
        { id: 'm-A', credentialId: 'c-oa', model: 'gpt-4o' },
        { id: 'm-B', credentialId: 'c-oa', model: 'gpt-5-mini' },
    ],
    routing,
});

describe('resolveTaskModel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('v2 verdict parity', () => {
        it('resolves the routed model (default) with slot + verdict + modelName parity', () => {
            const res = resolveTaskModel(v2({ defaultModelId: 'm-A' }), 'codeReview', {});

            expect(res.verdict?.modelId).toBe('m-A');
            expect(res.slot?.model).toBe('gpt-4o');
            expect(res.slot?.provider).toBe('openai');
            expect(res.modelName).toBe('openai:gpt-4o');
            // build() received the DECRYPTED key in local scope; the returned slot
            // still carries the ciphertext.
            expect(registryBuild).toHaveBeenCalledTimes(1);
            expect(registryBuild.mock.calls[0][0].apiKey).toBe('PLAINTEXT-enc-oa');
            expect(res.slot?.apiKey).toBe('enc-oa');
            expect((res.model as any).__sentinel).toBe('registry');
        });

        it('routes to an id override (verdict.modelId parity)', () => {
            const res = resolveTaskModel(
                v2({ defaultModelId: 'm-A' }),
                'codeReview',
                { ctx: { override: { modelId: 'm-B' } } },
            );

            expect(res.verdict?.modelId).toBe('m-B');
            expect(res.slot?.model).toBe('gpt-5-mini');
            expect(res.modelName).toBe('openai:gpt-5-mini');
        });

        it('applies a legacy NAME override onto the resolved slot (id-THEN-name)', () => {
            const res = resolveTaskModel(
                v2({ defaultModelId: 'm-A' }),
                'codeReview',
                { ctx: { override: { modelId: 'gpt-5-mini-name' } } },
            );

            // NAME is not a models[] id → default slot m-A (openai credential) with
            // the name applied onto `.model`.
            expect(res.verdict?.modelId).toBe('m-A');
            expect(res.verdict?.modelName).toBe('gpt-5-mini-name');
            expect(res.slot?.model).toBe('gpt-5-mini-name');
            expect(res.slot?.provider).toBe('openai');
            expect(res.modelName).toBe('openai:gpt-5-mini-name');
            // Ciphertext preserved through the name-override rewrite.
            expect(res.slot?.apiKey).toBe('enc-oa');
        });
    });

    describe('null slot → env/managed default (never throws)', () => {
        // Force `auto` deployment mode (no self-host env) so the null-slot path
        // deterministically takes the cloud default branch regardless of the
        // ambient process env. A non-kimi `defaultModelOverride` skips the
        // moonshot branch → the google default (`env-google`).
        const saved: Record<string, string | undefined> = {};
        beforeEach(() => {
            saved.mode = process.env.API_LLM_PROVIDER_MODEL;
            delete process.env.API_LLM_PROVIDER_MODEL; // → 'auto'
        });
        afterEach(() => {
            process.env.API_LLM_PROVIDER_MODEL = saved.mode;
        });

        it('no-BYOK (config null) yields a managed/env default model', () => {
            const res = resolveTaskModel(null, 'codeReview', {
                defaultModelOverride: 'gemini-2.5-flash',
            });

            expect(res.slot).toBeNull();
            expect(res.verdict).toBeNull();
            // The cloud managed default routes through the google_gemini provider
            // module (same registry build() as BYOK), carrying the default model.
            expect(registryBuild).toHaveBeenCalledTimes(1);
            expect(registryBuild.mock.calls[0][0].provider).toBe('google_gemini');
            expect(registryBuild.mock.calls[0][0].model).toBe('gemini-2.5-flash');
            expect((res.model as any).modelId).toBe('gemini-2.5-flash');
            expect(res.modelName).toBe('gemini-2.5-flash');
        });

        it('a BLOCKED verdict (managed credential) degrades to the env default', () => {
            const res = resolveTaskModel(
                v2(
                    { defaultModelId: 'm-M' },
                    [{ id: 'm-M', credentialId: 'c-m', model: 'gpt-4o' }],
                    [{ id: 'c-m', provider: 'openai', managed: true }],
                ),
                'codeReview',
                { defaultModelOverride: 'gemini-2.5-flash' },
            );

            // managed credential → StaticTaskStrategy skips → BLOCKED (modelId null)
            // → null slot → managed cloud default (google_gemini). Never throws.
            expect(res.verdict?.modelId).toBeNull();
            expect(res.slot).toBeNull();
            expect((res.model as any).provider).toBe('google_gemini');
        });
    });

    describe('self-host env-only', () => {
        const saved: Record<string, string | undefined> = {};
        beforeEach(() => {
            saved.mode = process.env.API_LLM_PROVIDER_MODEL;
            saved.key = process.env.API_OPEN_AI_API_KEY;
            saved.baseURL = process.env.API_OPENAI_FORCE_BASE_URL;
            process.env.API_LLM_PROVIDER_MODEL = 'gpt-4o-self';
            process.env.API_OPEN_AI_API_KEY = 'sk-env';
            delete process.env.API_OPENAI_FORCE_BASE_URL;
        });
        afterEach(() => {
            process.env.API_LLM_PROVIDER_MODEL = saved.mode;
            process.env.API_OPEN_AI_API_KEY = saved.key;
            process.env.API_OPENAI_FORCE_BASE_URL = saved.baseURL;
        });

        it('resolves a model from the env config with no DB row', () => {
            const res = resolveTaskModel(null, 'codeReview', {});

            expect(res.slot).toBeNull();
            expect((res.model as any).__sentinel).toBe('env-openai-compatible');
            expect((res.model as any).modelId).toBe('gpt-4o-self');
        });
    });

    describe('secret hygiene (log-spy)', () => {
        it('never leaks the decrypted key in a returned field or in any log', () => {
            const spies = [
                jest.spyOn(console, 'log').mockImplementation(() => {}),
                jest.spyOn(console, 'warn').mockImplementation(() => {}),
                jest.spyOn(console, 'error').mockImplementation(() => {}),
                jest.spyOn(console, 'info').mockImplementation(() => {}),
                jest.spyOn(console, 'debug').mockImplementation(() => {}),
            ];

            const res = resolveTaskModel(v2({ defaultModelId: 'm-A' }), 'codeReview', {});

            // Returned slot carries CIPHERTEXT — not the plaintext marker.
            expect(res.slot?.apiKey).toBe('enc-oa');
            expect(JSON.stringify(res.modelName)).not.toContain('PLAINTEXT');
            expect(JSON.stringify(res.verdict)).not.toContain('PLAINTEXT');

            const logged = spies
                .flatMap((s) => s.mock.calls)
                .map((args) => args.map((a) => String(a)).join(' '))
                .join(' | ');
            expect(logged).not.toContain('PLAINTEXT');

            spies.forEach((s) => s.mockRestore());
        });
    });
});
