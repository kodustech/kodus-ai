/**
 * CHARACTERIZATION (golden-master) tests for the env/managed-default path of
 * `buildModelFromSlot` — the `if (!config)` branch (no BYOK slot). These pin the
 * CURRENT behavior EXACTLY so a later refactor can be proven behavior-preserving.
 *
 * They must pass against the CURRENT code; if a case does not behave as the
 * ticket described, the assertion records what the code ACTUALLY does (see the
 * inline notes) rather than the expectation.
 *
 * Mock style mirrors `byok-to-vercel.spec.ts`: each SDK factory is a
 * `jest.fn` whose inner factory tags its return value with `{ sdk, modelId,
 * settings }`, so we can assert WHICH SDK factory was called with WHICH
 * apiKey / baseURL / model. This sibling file adds the `@ai-sdk/anthropic`
 * mock (absent from the original spec) because the env-default claude branch
 * routes through `createAnthropic`.
 */
import { BYOKProvider } from '@libs/llm/model-providers';

jest.mock('@ai-sdk/google-vertex', () => ({
    createVertex: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            sdk: 'vertex-gemini',
            modelId,
            settings,
        })),
    ),
}));
jest.mock('@ai-sdk/google-vertex/anthropic', () => ({
    createVertexAnthropic: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            sdk: 'vertex-anthropic',
            modelId,
            settings,
        })),
    ),
}));
jest.mock('@ai-sdk/amazon-bedrock', () => ({
    createAmazonBedrock: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({ sdk: 'bedrock', modelId, settings })),
    ),
}));
jest.mock('@libs/common/utils/crypto', () => ({ decrypt: (v: string) => v }));
jest.mock('@ai-sdk/openai', () => ({
    createOpenAI: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({ sdk: 'openai', modelId, settings })),
    ),
}));
jest.mock('@ai-sdk/anthropic', () => ({
    createAnthropic: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            sdk: 'anthropic',
            modelId,
            settings,
        })),
    ),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            sdk: 'openai-compatible',
            modelId,
            settings,
        })),
    ),
}));
jest.mock('@ai-sdk/google', () => ({
    createGoogleGenerativeAI: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({ sdk: 'google', modelId, settings })),
    ),
}));
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: () => undefined,
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
    }),
}));

import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { buildModelFromSlot } from './byok-to-vercel';

const createVertexMock = createVertex as unknown as jest.Mock;
const createVertexAnthropicMock = createVertexAnthropic as unknown as jest.Mock;
const createAnthropicMock = createAnthropic as unknown as jest.Mock;
const createOpenAICompatibleMock =
    createOpenAICompatible as unknown as jest.Mock;
const createGoogleGenerativeAIMock =
    createGoogleGenerativeAI as unknown as jest.Mock;

// A valid base64-encoded Service Account JSON with a project_id — the enterprise
// Vertex path. `decrypt` is identity in tests so the raw value IS what the code
// parses.
const SA_JSON_B64 = Buffer.from(
    JSON.stringify({
        type: 'service_account',
        project_id: 'my-proj',
        client_email: 'sa@my-proj.iam.gserviceaccount.com',
    }),
).toString('base64');

// Every env var the `if (!config)` branch reads. Snapshot + restore so the suite
// leaves the process environment untouched (other suites share this process).
const ENV_KEYS = [
    'API_LLM_PROVIDER_MODEL',
    'API_GOOGLE_AI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'API_VERTEX_AI_API_KEY',
    'API_VERTEX_AI_LOCATION',
    'API_OPEN_AI_API_KEY',
    'API_OPENAI_FORCE_BASE_URL',
    'API_MOONSHOT_API_KEY',
    'MOONSHOT_API_KEY',
] as const;

const savedEnv: Record<string, string | undefined> = {};

describe('buildModelFromSlot — env/managed default characterization (undefined slot)', () => {
    beforeAll(() => {
        for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    });

    beforeEach(() => {
        // Fully clear every relevant env before each case so each test declares
        // ONLY the vars it exercises (no leakage between branch tests).
        for (const k of ENV_KEYS) delete process.env[k];
        createVertexMock.mockClear();
        createVertexAnthropicMock.mockClear();
        createAnthropicMock.mockClear();
        createOpenAICompatibleMock.mockClear();
        createGoogleGenerativeAIMock.mockClear();
    });

    afterAll(() => {
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    // ── 1. gemini-* + AI Studio key (no proxy) → createGoogleGenerativeAI ─────
    it('gemini model + API_GOOGLE_AI_API_KEY → createGoogleGenerativeAI({apiKey: studioKey})(model)', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-2.5-pro';
        process.env.API_GOOGLE_AI_API_KEY = 'AIzaSyStudioKey';

        const result: any = buildModelFromSlot(undefined);

        expect(createGoogleGenerativeAIMock).toHaveBeenCalledTimes(1);
        expect(createVertexMock).not.toHaveBeenCalled();
        expect(result.sdk).toBe('google');
        expect(result.modelId).toBe('gemini-2.5-pro');
        expect(createGoogleGenerativeAIMock).toHaveBeenCalledWith({
            apiKey: 'AIzaSyStudioKey',
        });
    });

    // ── 2. gemini-* + base64 SA JSON in Vertex slot → Vertex Gemini protocol ──
    it('gemini model + API_VERTEX_AI_API_KEY (base64 SA JSON), no studio key → createVertex (Vertex Gemini)', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-2.5-pro';
        process.env.API_VERTEX_AI_API_KEY = SA_JSON_B64;
        process.env.API_VERTEX_AI_LOCATION = 'us-east5';

        const result: any = buildModelFromSlot(undefined);

        expect(createVertexMock).toHaveBeenCalledTimes(1);
        expect(createVertexAnthropicMock).not.toHaveBeenCalled();
        expect(createGoogleGenerativeAIMock).not.toHaveBeenCalled();
        expect(result.sdk).toBe('vertex-gemini');
        expect(result.modelId).toBe('gemini-2.5-pro');
        expect(createVertexMock).toHaveBeenCalledWith(
            expect.objectContaining({
                project: 'my-proj',
                location: 'us-east5',
            }),
        );
    });

    // ── 3. gemini-* + NON-base64 plain key in Vertex slot → fallback to Studio ─
    it('gemini model + API_VERTEX_AI_API_KEY (plain non-SA key) → falls back to createGoogleGenerativeAI({apiKey: vertexKey})', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-2.5-pro';
        // Not base64-of-JSON: base64-decoding then JSON.parse throws in
        // parseSaCredentials → vertexModelFromSaJson returns null → fallback.
        process.env.API_VERTEX_AI_API_KEY = 'AIzaSyPlainVertexSlotKey';

        const result: any = buildModelFromSlot(undefined);

        expect(createVertexMock).not.toHaveBeenCalled();
        expect(createGoogleGenerativeAIMock).toHaveBeenCalledTimes(1);
        expect(result.sdk).toBe('google');
        expect(result.modelId).toBe('gemini-2.5-pro');
        expect(createGoogleGenerativeAIMock).toHaveBeenCalledWith({
            apiKey: 'AIzaSyPlainVertexSlotKey',
        });
    });

    // ── 4a. claude-* + API_OPEN_AI_API_KEY (no baseURL) → native createAnthropic
    it('claude model + API_OPEN_AI_API_KEY, no base URL → createAnthropic({apiKey})(model), no baseURL prop', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'claude-sonnet-4-5';
        process.env.API_OPEN_AI_API_KEY = 'sk-anthropic-key';

        const result: any = buildModelFromSlot(undefined);

        expect(createAnthropicMock).toHaveBeenCalledTimes(1);
        expect(result.sdk).toBe('anthropic');
        expect(result.modelId).toBe('claude-sonnet-4-5');
        expect(createAnthropicMock).toHaveBeenCalledWith({
            apiKey: 'sk-anthropic-key',
        });
        // baseURL omitted when the force-URL env is unset (native SDK default).
        expect(createAnthropicMock.mock.calls[0][0]).not.toHaveProperty(
            'baseURL',
        );
    });

    // ── 4b. claude-* + API_OPEN_AI_API_KEY + explicit api.anthropic.com base URL
    it('claude model + API_OPEN_AI_API_KEY + API_OPENAI_FORCE_BASE_URL(api.anthropic.com) → createAnthropic forwards baseURL', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'claude-sonnet-4-5';
        process.env.API_OPEN_AI_API_KEY = 'sk-anthropic-key';
        // api.anthropic.com is NOT a proxy (isProxyBaseURL === false) → native
        // path stays, and the explicit override is forwarded.
        process.env.API_OPENAI_FORCE_BASE_URL = 'https://api.anthropic.com/v1';

        const result: any = buildModelFromSlot(undefined);

        expect(createAnthropicMock).toHaveBeenCalledTimes(1);
        expect(result.sdk).toBe('anthropic');
        expect(createAnthropicMock).toHaveBeenCalledWith({
            apiKey: 'sk-anthropic-key',
            baseURL: 'https://api.anthropic.com/v1',
        });
    });

    // ── 5. claude-* + only base64 SA JSON (no openai key) → Claude-on-Vertex ──
    it('claude model + only API_VERTEX_AI_API_KEY (base64 SA JSON) → createVertexAnthropic (Claude on Vertex)', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'claude-sonnet-4-5';
        process.env.API_VERTEX_AI_API_KEY = SA_JSON_B64;

        const result: any = buildModelFromSlot(undefined);

        expect(createVertexAnthropicMock).toHaveBeenCalledTimes(1);
        expect(createAnthropicMock).not.toHaveBeenCalled();
        expect(createVertexMock).not.toHaveBeenCalled();
        expect(result.sdk).toBe('vertex-anthropic');
        expect(result.modelId).toBe('claude-sonnet-4-5');
        // No location env → defaults to the global endpoint.
        expect(createVertexAnthropicMock).toHaveBeenCalledWith(
            expect.objectContaining({
                project: 'my-proj',
                location: 'global',
            }),
        );
    });

    // ── 6a. non-gemini/non-claude + openai key → OpenAI-compatible (default off)
    it('openai-style model + API_OPEN_AI_API_KEY → createOpenAICompatible({name:self-hosted, default openai.com base, structured OFF})', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gpt-4o';
        process.env.API_OPEN_AI_API_KEY = 'sk-openai';

        const result: any = buildModelFromSlot(undefined);

        expect(createOpenAICompatibleMock).toHaveBeenCalledTimes(1);
        expect(result.sdk).toBe('openai-compatible');
        expect(result.modelId).toBe('gpt-4o');
        expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
            name: 'self-hosted',
            apiKey: 'sk-openai',
            baseURL: 'https://api.openai.com/v1',
            supportsStructuredOutputs: false,
        });
    });

    // ── 6b. same, but structuredOutputs opt-in flips supportsStructuredOutputs ─
    it('openai-style model + structuredOutputs opt-in → supportsStructuredOutputs:true and forced base URL forwarded', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gpt-4o';
        process.env.API_OPEN_AI_API_KEY = 'sk-openai';
        process.env.API_OPENAI_FORCE_BASE_URL = 'https://litellm.internal/v1';

        const result: any = buildModelFromSlot(undefined, {
            structuredOutputs: true,
        });

        expect(result.sdk).toBe('openai-compatible');
        expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
            name: 'self-hosted',
            apiKey: 'sk-openai',
            baseURL: 'https://litellm.internal/v1',
            supportsStructuredOutputs: true,
        });
    });

    // ── 7. auto env + kimi default → Moonshot OpenAI-compatible ───────────────
    it('auto env (unset) + kimi default → createOpenAICompatible({name:moonshot, moonshot key, moonshot base})(defaultModel)', () => {
        // API_LLM_PROVIDER_MODEL unset → 'auto'; default model is kimi-*.
        process.env.API_MOONSHOT_API_KEY = 'ms-key';

        const result: any = buildModelFromSlot(undefined);

        expect(createOpenAICompatibleMock).toHaveBeenCalledTimes(1);
        expect(result.sdk).toBe('openai-compatible');
        expect(result.modelId).toBe('kimi-k2.7-code');
        expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
            name: 'moonshot',
            apiKey: 'ms-key',
            baseURL: 'https://api.moonshot.ai/v1',
        });
    });

    // ── 8. auto env + gemini default (NOT kimi) → cloud Gemini default ────────
    it('auto env + gemini defaultModelOverride → createGoogleGenerativeAI({apiKey: googleKey})(defaultModel)', () => {
        // Still 'auto', so the self-host block is skipped; override picks a
        // gemini-* default (not kimi) → cloud Gemini default branch.
        process.env.API_GOOGLE_AI_API_KEY = 'AIzaSyCloudDefault';

        const result: any = buildModelFromSlot(
            undefined,
            {},
            'gemini-3.1-pro-preview-customtools',
        );

        expect(createGoogleGenerativeAIMock).toHaveBeenCalledTimes(1);
        expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
        expect(result.sdk).toBe('google');
        expect(result.modelId).toBe('gemini-3.1-pro-preview-customtools');
        expect(createGoogleGenerativeAIMock).toHaveBeenCalledWith({
            apiKey: 'AIzaSyCloudDefault',
        });
    });

    // ── 9. self-hosted mode declared but NO usable env key → falls to default ─
    it('self-hosted model declared but NO env key → falls through to the kimi default (does NOT throw)', () => {
        // openai-style model id but neither openai key nor vertex/studio keys.
        process.env.API_LLM_PROVIDER_MODEL = 'some-self-hosted-model';
        process.env.API_MOONSHOT_API_KEY = 'ms-key';

        const result: any = buildModelFromSlot(undefined);

        // No native/openai-compat branch fired for the declared model; execution
        // fell through to the kimi default (DEFAULT_MODEL.model = kimi-k2.7-code).
        expect(result.sdk).toBe('openai-compatible');
        expect(result.modelId).toBe('kimi-k2.7-code');
        expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'moonshot' }),
        );
        expect(createAnthropicMock).not.toHaveBeenCalled();
    });

    // ── proxy gate: claude-* + proxy base URL SKIPS the native createAnthropic ─
    it('claude model + PROXY base URL (openrouter) does NOT take native createAnthropic — routes OpenAI-compatible', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'claude-sonnet-4-5';
        process.env.API_OPEN_AI_API_KEY = 'sk-proxy-key';
        // A non-anthropic base URL → isProxyBaseURL === true → viaProxy gate
        // skips BOTH claude native branches (Anthropic + Vertex-Anthropic).
        process.env.API_OPENAI_FORCE_BASE_URL = 'https://openrouter.ai/api/v1';

        const result: any = buildModelFromSlot(undefined);

        expect(createAnthropicMock).not.toHaveBeenCalled();
        expect(createVertexAnthropicMock).not.toHaveBeenCalled();
        expect(result.sdk).toBe('openai-compatible');
        expect(result.modelId).toBe('claude-sonnet-4-5');
        expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
            name: 'self-hosted',
            apiKey: 'sk-proxy-key',
            baseURL: 'https://openrouter.ai/api/v1',
            supportsStructuredOutputs: false,
        });
    });
});
