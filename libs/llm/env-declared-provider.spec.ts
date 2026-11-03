import { resolveDeclaredEnvProvider } from './env-declared-provider';

const env = (vars: Record<string, string>): NodeJS.ProcessEnv =>
    ({ API_LLM_PROVIDER_MODEL: 'some-model', ...vars }) as any;

describe('resolveDeclaredEnvProvider', () => {
    it('leaves an install with no API_LLM_* var to the inference', () => {
        expect(
            resolveDeclaredEnvProvider(env({ API_OPEN_AI_API_KEY: 'sk-x' })),
        ).toEqual({ kind: 'inferred' });
    });

    it('ignores everything on cloud (auto), even a declared provider', () => {
        expect(
            resolveDeclaredEnvProvider({
                API_LLM_PROVIDER_MODEL: 'auto',
                API_LLM_PROVIDER: 'openai',
                API_LLM_API_KEY: 'sk-x',
            } as any),
        ).toEqual({ kind: 'inferred' });
    });

    it.each([
        'API_LLM_API_KEY',
        'API_LLM_BASE_URL',
        'API_LLM_REASONING_EFFORT',
    ])(
        'reports %s set without API_LLM_PROVIDER instead of ignoring it',
        (name) => {
            const result = resolveDeclaredEnvProvider(
                env({
                    [name]:
                        name === 'API_LLM_BASE_URL'
                            ? 'https://x.test/v1'
                            : 'low',
                }),
            );
            expect(result.kind).toBe('invalid');
            expect(result.kind === 'invalid' && result.reason).toContain(
                `${name} requires API_LLM_PROVIDER`,
            );
        },
    );

    it('rejects a provider outside the declarable ones, listing them', () => {
        const result = resolveDeclaredEnvProvider(
            env({ API_LLM_PROVIDER: 'open_router', API_LLM_API_KEY: 'k' }),
        );
        expect(result).toEqual({
            kind: 'invalid',
            reason: 'API_LLM_PROVIDER="open_router" is not supported. Use one of: openai, openai_compatible, anthropic, anthropic_compatible, google_gemini, google_vertex.',
        });
    });

    it('runs anthropic_compatible on its own endpoint, with the /v1 kept', () => {
        expect(
            resolveDeclaredEnvProvider(
                env({
                    API_LLM_PROVIDER: 'anthropic_compatible',
                    API_LLM_API_KEY: 'k',
                    API_LLM_BASE_URL: 'https://api.moonshot.ai/anthropic',
                }),
            ),
        ).toEqual({
            kind: 'declared',
            config: {
                provider: 'anthropic_compatible',
                model: 'some-model',
                apiKey: 'k',
                baseURL: 'https://api.moonshot.ai/anthropic',
            },
            warnings: [],
        });
    });

    it('rejects anthropic_compatible without a base URL: it has no endpoint of its own', () => {
        expect(
            resolveDeclaredEnvProvider(
                env({
                    API_LLM_PROVIDER: 'anthropic_compatible',
                    API_LLM_API_KEY: 'k',
                    // Not read for this provider: it is the OpenAI-named one.
                    API_OPENAI_FORCE_BASE_URL:
                        'https://api.moonshot.ai/anthropic',
                }),
            ),
        ).toEqual({
            kind: 'invalid',
            reason: 'API_LLM_PROVIDER=anthropic_compatible has no endpoint of its own. Set API_LLM_BASE_URL.',
        });
    });

    it('rejects an unknown reasoning effort', () => {
        const result = resolveDeclaredEnvProvider(
            env({
                API_LLM_PROVIDER: 'openai',
                API_LLM_API_KEY: 'k',
                API_LLM_REASONING_EFFORT: 'max',
            }),
        );
        expect(result.kind).toBe('invalid');
    });

    it('rejects a base URL for a provider that cannot be moved', () => {
        const result = resolveDeclaredEnvProvider(
            env({
                API_LLM_PROVIDER: 'google_gemini',
                API_LLM_API_KEY: 'k',
                API_LLM_BASE_URL: 'https://proxy.test/v1',
            }),
        );
        expect(result.kind).toBe('invalid');
    });

    it('names the accepted key vars when a declared provider has no key', () => {
        const result = resolveDeclaredEnvProvider(
            env({ API_LLM_PROVIDER: 'google_gemini' }),
        );
        expect(result).toEqual({
            kind: 'invalid',
            reason: 'API_LLM_PROVIDER=google_gemini has no API key. Set API_LLM_API_KEY or API_GOOGLE_AI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY.',
        });
    });

    it('never puts a key value in a warning', () => {
        const result = resolveDeclaredEnvProvider(
            env({
                API_LLM_PROVIDER: 'openai',
                API_LLM_API_KEY: 'sk-generic-secret',
                API_OPEN_AI_API_KEY: 'sk-legacy-secret',
            }),
        );
        expect(result.kind).toBe('declared');
        if (result.kind !== 'declared') return;
        expect(result.warnings).toHaveLength(1);
        expect(JSON.stringify(result.warnings)).not.toMatch(/secret/);
    });

    it.each([
        ['an unknown effort', { API_LLM_REASONING_EFFORT: 'max' }],
        ['an unsupported provider', { API_LLM_PROVIDER: 'open_router' }],
        [
            'a base URL Gemini cannot take',
            {
                API_LLM_PROVIDER: 'google_gemini',
                API_LLM_BASE_URL: 'https://proxy.test/v1',
            },
        ],
    ])('never puts a key value in the reason for %s', (_, vars) => {
        const result = resolveDeclaredEnvProvider(
            env({
                API_LLM_PROVIDER: 'openai',
                API_LLM_API_KEY: 'sk-generic-secret',
                API_OPEN_AI_API_KEY: 'sk-legacy-secret',
                ...vars,
            }),
        );
        expect(result.kind).toBe('invalid');
        if (result.kind !== 'invalid') return;
        expect(result.reason).not.toMatch(/secret/);
    });

    it('reads API_ANTHROPIC_API_KEY for anthropic before the OpenAI-named key', () => {
        const result = resolveDeclaredEnvProvider(
            env({
                API_LLM_PROVIDER: 'anthropic',
                API_ANTHROPIC_API_KEY: 'sk-ant-own',
                API_OPEN_AI_API_KEY: 'sk-ant-legacy',
            }),
        );
        expect(result.kind === 'declared' && result.config.apiKey).toBe(
            'sk-ant-own',
        );
    });

    it('still runs anthropic on API_OPEN_AI_API_KEY alone, as installs did before', () => {
        const result = resolveDeclaredEnvProvider(
            env({
                API_LLM_PROVIDER: 'anthropic',
                API_OPEN_AI_API_KEY: 'sk-ant-legacy',
            }),
        );
        expect(result.kind === 'declared' && result.config.apiKey).toBe(
            'sk-ant-legacy',
        );
    });

    it('prefers the generic key and warns when the legacy one disagrees', () => {
        const result = resolveDeclaredEnvProvider(
            env({
                API_LLM_PROVIDER: 'openai',
                API_LLM_API_KEY: 'sk-new',
                API_OPEN_AI_API_KEY: 'sk-old',
            }),
        );
        expect(result.kind).toBe('declared');
        if (result.kind !== 'declared') return;
        expect(result.config.apiKey).toBe('sk-new');
        expect(result.warnings).toEqual([
            'API_LLM_API_KEY and API_OPEN_AI_API_KEY are both set to different values; API_LLM_API_KEY is used.',
        ]);
    });

    it('does not warn when generic and legacy agree', () => {
        const result = resolveDeclaredEnvProvider(
            env({
                API_LLM_PROVIDER: 'openai',
                API_LLM_API_KEY: 'sk-same',
                API_OPEN_AI_API_KEY: 'sk-same',
            }),
        );
        expect(result.kind === 'declared' && result.warnings).toEqual([]);
    });

    it('falls back to the legacy key and base URL when the generic ones are empty', () => {
        const result = resolveDeclaredEnvProvider(
            env({
                API_LLM_PROVIDER: 'anthropic',
                API_OPEN_AI_API_KEY: 'sk-ant',
                API_OPENAI_FORCE_BASE_URL: 'https://gateway.test/v1',
            }),
        );
        expect(result).toEqual({
            kind: 'declared',
            config: {
                provider: 'anthropic',
                model: 'some-model',
                apiKey: 'sk-ant',
                baseURL: 'https://gateway.test/v1',
            },
            warnings: [],
        });
    });

    it('defaults openai_compatible to the OpenAI endpoint', () => {
        const result = resolveDeclaredEnvProvider(
            env({
                API_LLM_PROVIDER: 'openai_compatible',
                API_LLM_API_KEY: 'k',
            }),
        );
        expect(result.kind === 'declared' && result.config.baseURL).toBe(
            'https://api.openai.com/v1',
        );
    });

    it('accepts keyless Vertex through ADC', () => {
        const result = resolveDeclaredEnvProvider(
            env({
                API_LLM_PROVIDER: 'google_vertex',
                GOOGLE_CLOUD_PROJECT: 'proj',
            }),
        );
        expect(result).toEqual({
            kind: 'declared',
            config: {
                provider: 'google_vertex',
                model: 'some-model',
                adcProject: 'proj',
                vertexLocation: 'global',
            },
            warnings: [],
        });
    });

    it('carries the declared reasoning effort', () => {
        const result = resolveDeclaredEnvProvider(
            env({
                API_LLM_PROVIDER: 'openai',
                API_LLM_API_KEY: 'k',
                API_LLM_REASONING_EFFORT: 'none',
            }),
        );
        expect(
            result.kind === 'declared' && result.config.reasoningEffort,
        ).toBe('none');
    });

    it('removes the endpoint the SDK appends from the base URL, and says so', () => {
        const result = resolveDeclaredEnvProvider(
            env({
                API_LLM_PROVIDER: 'openai_compatible',
                API_LLM_API_KEY: 'k',
                API_LLM_BASE_URL: 'https://proxy.test/v1/chat/completions',
            }),
        );
        expect(result.kind).toBe('declared');
        if (result.kind !== 'declared') return;
        expect(result.config.baseURL).toBe('https://proxy.test/v1');
        expect(result.warnings).toEqual([
            'API_LLM_BASE_URL ends with the endpoint the provider SDK adds itself; https://proxy.test/v1 is used.',
        ]);
    });
});
