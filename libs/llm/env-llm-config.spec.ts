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

describe('describeEnvLLMConfig — mutation hardening', () => {
    // --- envMode gate boundaries ---

    it('treats an empty-string model as a real (non-auto) value via ?? not ||', () => {
        // A `??` -> `||` mutant would coerce '' to 'auto' and return not
        // configured; with `??`, '' is a distinct model that still resolves.
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: '',
                API_OPEN_AI_API_KEY: 'sk-test',
            } as any),
        ).toEqual({
            configured: true,
            model: '',
            providerId: 'openai_compatible',
            baseUrl: 'https://api.openai.com/v1',
        });
    });

    // --- isProxyBaseURL / anthropic native baseUrl ---

    it('keeps Anthropic native when baseURL is exactly api.anthropic.com and echoes it', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'claude-3-5-sonnet',
                API_OPEN_AI_API_KEY: 'sk-ant',
                API_OPENAI_FORCE_BASE_URL: 'https://api.anthropic.com',
            } as any),
        ).toEqual({
            configured: true,
            model: 'claude-3-5-sonnet',
            providerId: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
        });
    });

    it('honors the api.anthropic.com path suffix (word boundary) as non-proxy', () => {
        const result = describeEnvLLMConfig({
            API_LLM_PROVIDER_MODEL: 'claude-3-5-sonnet',
            API_OPEN_AI_API_KEY: 'sk-ant',
            API_OPENAI_FORCE_BASE_URL: 'https://api.anthropic.com/v1',
        } as any);
        expect(result.providerId).toBe('anthropic');
        expect(result.baseUrl).toBe('https://api.anthropic.com/v1');
    });

    // --- gemini branch requires !viaProxy ---

    it('routes a gemini model through OpenAI-compatible when a proxy baseURL is set (studio key ignored)', () => {
        // The `isGemini && !viaProxy` guard must fall through to the generic
        // openai path; dropping `!viaProxy` would wrongly return google_gemini.
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini-2.5-pro',
                API_GOOGLE_AI_API_KEY: 'AIzaStudio',
                API_OPEN_AI_API_KEY: 'sk-proxy',
                API_OPENAI_FORCE_BASE_URL: 'https://openrouter.ai/api/v1',
            } as any),
        ).toEqual({
            configured: true,
            model: 'gemini-2.5-pro',
            providerId: 'openai_compatible',
            baseUrl: 'https://openrouter.ai/api/v1',
        });
    });

    // --- provider precedence within the gemini branch ---

    it('prefers the AI Studio key over a Vertex SA-JSON key (studio wins)', () => {
        const saJson = Buffer.from(
            JSON.stringify({ project_id: 'proj' }),
        ).toString('base64');
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini-2.5-pro',
                API_GOOGLE_AI_API_KEY: 'AIzaStudio',
                API_VERTEX_AI_API_KEY: saJson,
            } as any),
        ).toEqual({
            configured: true,
            model: 'gemini-2.5-pro',
            providerId: 'google_gemini',
        });
    });

    it('accepts GOOGLE_GENERATIVE_AI_API_KEY as the AI Studio key alias', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini-2.5-pro',
                GOOGLE_GENERATIVE_AI_API_KEY: 'AIzaAlias',
            } as any),
        ).toEqual({
            configured: true,
            model: 'gemini-2.5-pro',
            providerId: 'google_gemini',
        });
    });

    // --- looksLikeBase64Json edges ---

    it('defaults the Vertex SA-JSON location to us-central1 when unset', () => {
        const saJson = Buffer.from(
            JSON.stringify({ project_id: 'proj' }),
        ).toString('base64');
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini-2.5-pro',
                API_VERTEX_AI_API_KEY: saJson,
            } as any),
        ).toEqual({
            configured: true,
            model: 'gemini-2.5-pro',
            providerId: 'google_vertex',
            vertexLocation: 'us-central1',
        });
    });

    it('treats decodable JSON without project_id as a plain key (Gemini AI Studio)', () => {
        const noProject = Buffer.from(
            JSON.stringify({ foo: 'bar' }),
        ).toString('base64');
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini-2.5-pro',
                API_VERTEX_AI_API_KEY: noProject,
            } as any),
        ).toEqual({
            configured: true,
            model: 'gemini-2.5-pro',
            providerId: 'google_gemini',
        });
    });

    it('treats an empty project_id as falsy (Gemini AI Studio, not Vertex)', () => {
        const emptyProject = Buffer.from(
            JSON.stringify({ project_id: '' }),
        ).toString('base64');
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini-2.5-pro',
                API_VERTEX_AI_API_KEY: emptyProject,
            } as any),
        ).toEqual({
            configured: true,
            model: 'gemini-2.5-pro',
            providerId: 'google_gemini',
        });
    });

    // --- claude precedence: native key beats vertex key ---

    it('prefers the native Anthropic key over a Vertex key for claude models', () => {
        const saJson = Buffer.from(
            JSON.stringify({ project_id: 'proj' }),
        ).toString('base64');
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'claude-3-5-sonnet',
                API_OPEN_AI_API_KEY: 'sk-ant',
                API_VERTEX_AI_API_KEY: saJson,
            } as any),
        ).toEqual({
            configured: true,
            model: 'claude-3-5-sonnet',
            providerId: 'anthropic',
            baseUrl: undefined,
        });
    });

    // --- claude-on-vertex via SA key (no base64 check for claude) ---

    it('routes claude to Vertex with any vertex key, defaulting location to global', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'claude-sonnet-4-5',
                API_VERTEX_AI_API_KEY: 'plain-non-json-key',
            } as any),
        ).toEqual({
            configured: true,
            model: 'claude-sonnet-4-5',
            providerId: 'google_vertex',
            vertexLocation: 'global',
        });
    });

    it('honors API_VERTEX_AI_LOCATION for claude-on-Vertex via key', () => {
        const result = describeEnvLLMConfig({
            API_LLM_PROVIDER_MODEL: 'claude-sonnet-4-5',
            API_VERTEX_AI_API_KEY: 'plain-key',
            API_VERTEX_AI_LOCATION: 'europe-west1',
        } as any);
        expect(result.providerId).toBe('google_vertex');
        expect(result.vertexLocation).toBe('europe-west1');
    });

    // --- claude ADC exact shape ---

    it('detects keyless claude Vertex ADC with the global location default', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'claude-sonnet-4-5',
                GOOGLE_CLOUD_PROJECT: 'my-gcp-project',
            } as any),
        ).toEqual({
            configured: true,
            model: 'claude-sonnet-4-5',
            providerId: 'google_vertex',
            vertexLocation: 'global',
        });
    });

    it('does NOT switch claude to ADC when an explicit OpenAI key is set', () => {
        // openaiKey present but claude/no-vertex -> viaProxy false -> anthropic
        // native, never the ADC google_vertex path.
        const result = describeEnvLLMConfig({
            API_LLM_PROVIDER_MODEL: 'claude-sonnet-4-5',
            GOOGLE_CLOUD_PROJECT: 'my-gcp-project',
            API_OPEN_AI_API_KEY: 'sk-ant',
        } as any);
        expect(result.providerId).toBe('anthropic');
    });

    // --- vertexProjectFromEnv trim / empty guard ---

    it('treats a whitespace-only ADC project as absent (not configured)', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini-2.5-flash',
                GOOGLE_CLOUD_PROJECT: '   ',
            } as any),
        ).toEqual({ configured: false });
    });

    // --- separator class [-_] in the model patterns ---

    it('recognises the underscore separator in claude_/gemini_ model ids', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'claude_3_opus',
                API_OPEN_AI_API_KEY: 'sk-ant',
            } as any).providerId,
        ).toBe('anthropic');
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini_2_5_pro',
                API_GOOGLE_AI_API_KEY: 'AIzaStudio',
            } as any).providerId,
        ).toBe('google_gemini');
    });

    // --- temperatureOverride: boundary and cross-branch application ---

    it('keeps a temperatureOverride of exactly 0 (guards !== undefined, not truthiness)', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gpt-4o',
                API_OPEN_AI_API_KEY: 'sk-test',
                API_LLM_TEMPERATURE_OVERRIDE: '0',
            } as any),
        ).toEqual({
            configured: true,
            model: 'gpt-4o',
            providerId: 'openai_compatible',
            baseUrl: 'https://api.openai.com/v1',
            temperatureOverride: 0,
        });
    });

    it('parses negative temperature overrides', () => {
        const result = describeEnvLLMConfig({
            API_LLM_PROVIDER_MODEL: 'gpt-4o',
            API_OPEN_AI_API_KEY: 'sk-test',
            API_LLM_TEMPERATURE_OVERRIDE: '-1',
        } as any);
        expect(result.temperatureOverride).toBe(-1);
    });

    it('applies the temperatureOverride onto the Vertex descriptor branch too', () => {
        const saJson = Buffer.from(
            JSON.stringify({ project_id: 'proj' }),
        ).toString('base64');
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'gemini-2.5-pro',
                API_VERTEX_AI_API_KEY: saJson,
                API_VERTEX_AI_LOCATION: 'us-east1',
                API_LLM_TEMPERATURE_OVERRIDE: '0.7',
            } as any),
        ).toEqual({
            configured: true,
            model: 'gemini-2.5-pro',
            providerId: 'google_vertex',
            vertexLocation: 'us-east1',
            temperatureOverride: 0.7,
        });
    });

    it('applies the temperatureOverride onto the Anthropic descriptor branch too', () => {
        expect(
            describeEnvLLMConfig({
                API_LLM_PROVIDER_MODEL: 'claude-3-5-sonnet',
                API_OPEN_AI_API_KEY: 'sk-ant',
                API_LLM_TEMPERATURE_OVERRIDE: '0.3',
            } as any),
        ).toEqual({
            configured: true,
            model: 'claude-3-5-sonnet',
            providerId: 'anthropic',
            baseUrl: undefined,
            temperatureOverride: 0.3,
        });
    });
});
