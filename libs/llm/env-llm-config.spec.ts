import { describeEnvLLMConfig } from './env-llm-config';

describe('describeEnvLLMConfig', () => {
    it('returns not configured when API_LLM_PROVIDER_MODEL is unset', () => {
        expect(describeEnvLLMConfig({} as any)).toEqual({ configured: false });
    });

    it('returns not configured for auto mode', () => {
        expect(
            describeEnvLLMConfig({ API_LLM_PROVIDER_MODEL: 'auto' } as any),
        ).toEqual({ configured: false });
    });

    it('returns not configured when model is set but no key matches', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini-2.5-pro',
            } as any),
        ).toEqual({ configured: false });
    });

    it('detects OpenAI-compatible with explicit baseURL', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gpt-4o',
                API_OPEN_AI_API_KEY: 'sk-test',
                API_OPENAI_FORCE_BASE_URL: 'https://api.openai.com/v1',
            } as any),
        ).toEqual({
            configured: true,
            model: 'gpt-4o',
            providerId: 'openai_compatible',
            baseUrl: 'https://api.openai.com/v1',
        });
    });

    it('defaults the OpenAI-compatible baseURL when only the key is set', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gpt-4o',
                API_OPEN_AI_API_KEY: 'sk-test',
            } as any),
        ).toEqual({
            configured: true,
            model: 'gpt-4o',
            providerId: 'openai_compatible',
            baseUrl: 'https://api.openai.com/v1',
        });
    });

    it('detects Anthropic native when model is claude- and key is set with no proxy baseURL', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'claude-3-5-sonnet',
                API_OPEN_AI_API_KEY: 'sk-ant',
            } as any),
        ).toEqual({
            configured: true,
            model: 'claude-3-5-sonnet',
            providerId: 'anthropic',
            baseUrl: undefined,
        });
    });

    it('forces OpenAI-compatible when a non-Anthropic baseURL is set even with claude-* model', () => {
        const result = describeEnvLLMConfig({
            API_LLM_PROVIDER_MODEL: 'claude-3-5-sonnet',
            API_OPEN_AI_API_KEY: 'sk-proxy',
            API_OPENAI_FORCE_BASE_URL: 'https://openrouter.ai/api/v1',
        } as any);
        expect(result.providerId).toBe('openai_compatible');
        expect(result.baseUrl).toBe('https://openrouter.ai/api/v1');
    });

    it('detects Google Gemini (AI Studio) when gemini-* model and studio key are set', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini-2.5-pro',
                API_GOOGLE_AI_API_KEY: 'AIzaSyFoo',
            } as any),
        ).toEqual({
            configured: true,
            model: 'gemini-2.5-pro',
            providerId: 'google_gemini',
        });
    });

    it('detects Vertex AI when the vertex key is a valid base64 SA JSON', () => {
        const saJson = Buffer.from(
            JSON.stringify({ project_id: 'my-project' }),
        ).toString('base64');
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini-2.5-pro',
                API_VERTEX_AI_API_KEY: saJson,
                API_VERTEX_AI_LOCATION: 'us-east1',
            } as any),
        ).toEqual({
            configured: true,
            model: 'gemini-2.5-pro',
            providerId: 'google_vertex',
            vertexLocation: 'us-east1',
        });
    });

    it('falls back to Gemini AI Studio when vertex key is not an SA JSON', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini-2.5-pro',
                API_VERTEX_AI_API_KEY: 'AIzaSyPlain',
            } as any),
        ).toEqual({
            configured: true,
            model: 'gemini-2.5-pro',
            providerId: 'google_gemini',
        });
    });

    it('surfaces API_LLM_TEMPERATURE_OVERRIDE when set to a number', () => {
        const result = describeEnvLLMConfig({
            API_LLM_PROVIDER_MODEL: 'kimi-k2.6',
            API_OPEN_AI_API_KEY: 'sk-moonshot',
            API_OPENAI_FORCE_BASE_URL: 'https://api.moonshot.ai/v1',
            API_LLM_TEMPERATURE_OVERRIDE: '1',
        } as any);
        expect(result.configured).toBe(true);
        expect(result.temperatureOverride).toBe(1);
    });

    it('parses fractional temperature overrides', () => {
        const result = describeEnvLLMConfig({
            API_LLM_PROVIDER_MODEL: 'gpt-4o',
            API_OPEN_AI_API_KEY: 'sk-test',
            API_LLM_TEMPERATURE_OVERRIDE: '0.5',
        } as any);
        expect(result.temperatureOverride).toBe(0.5);
    });

    it('omits temperatureOverride when the env var is empty', () => {
        const result = describeEnvLLMConfig({
            API_LLM_PROVIDER_MODEL: 'gpt-4o',
            API_OPEN_AI_API_KEY: 'sk-test',
            API_LLM_TEMPERATURE_OVERRIDE: '',
        } as any);
        expect(result.configured).toBe(true);
        expect(result.temperatureOverride).toBeUndefined();
    });

    it('omits temperatureOverride when the env var is non-numeric', () => {
        const result = describeEnvLLMConfig({
            API_LLM_PROVIDER_MODEL: 'gpt-4o',
            API_OPEN_AI_API_KEY: 'sk-test',
            API_LLM_TEMPERATURE_OVERRIDE: 'not-a-number',
        } as any);
        expect(result.configured).toBe(true);
        expect(result.temperatureOverride).toBeUndefined();
    });

    // Keyless Vertex ADC (PR #1652). The model builds via vertexModelFromAdc,
    // so the descriptor MUST report configured — a false-negative here shows
    // "No LLM provider configured" and gates reviews off on a working deploy.
    it('detects keyless Vertex ADC (gemini) when only GOOGLE_CLOUD_PROJECT is set', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini-2.5-flash',
                GOOGLE_CLOUD_PROJECT: 'my-gcp-project',
            } as any),
        ).toEqual({
            configured: true,
            model: 'gemini-2.5-flash',
            providerId: 'google_vertex',
            vertexLocation: 'global',
        });
    });

    it('accepts GCLOUD_PROJECT as the ADC project alias', () => {
        const result = describeEnvLLMConfig({
            API_LLM_PROVIDER_MODEL: 'gemini-3-pro',
            GCLOUD_PROJECT: 'aliased-project',
        } as any);
        expect(result.configured).toBe(true);
        expect(result.providerId).toBe('google_vertex');
    });

    it('honors API_VERTEX_AI_LOCATION on the ADC path', () => {
        const result = describeEnvLLMConfig({
            API_LLM_PROVIDER_MODEL: 'gemini-2.5-flash',
            GOOGLE_CLOUD_PROJECT: 'my-gcp-project',
            API_VERTEX_AI_LOCATION: 'us-east4',
        } as any);
        expect(result.vertexLocation).toBe('us-east4');
    });

    it('does NOT switch to ADC when an explicit OpenAI key is set (key wins)', () => {
        const result = describeEnvLLMConfig({
            API_LLM_PROVIDER_MODEL: 'gemini-2.5-flash',
            GOOGLE_CLOUD_PROJECT: 'my-gcp-project',
            API_OPEN_AI_API_KEY: 'sk-test',
        } as any);
        // Mirrors resolveEnvProvider: an explicit OpenAI key must not be
        // silently switched to a Vertex identity it never opted into.
        expect(result.providerId).toBe('openai_compatible');
    });

    it('detects keyless Vertex ADC for claude-* models too', () => {
        const result = describeEnvLLMConfig({
            API_LLM_PROVIDER_MODEL: 'claude-sonnet-4-5',
            GOOGLE_CLOUD_PROJECT: 'my-gcp-project',
        } as any);
        expect(result.configured).toBe(true);
        expect(result.providerId).toBe('google_vertex');
    });

    it('still reports not configured for gemini with neither key nor project', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini-2.5-flash',
            } as any),
        ).toEqual({ configured: false });
    });
});
