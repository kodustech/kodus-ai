import { BYOKProvider } from '@kodus/kodus-common/llm';

// Keep the env-LLM branch deterministic: these tests exercise the BYOK
// detection logic, so env is always "not configured" here.
jest.mock('@libs/llm/env-llm-config', () => ({
    describeEnvLLMConfig: jest.fn(() => ({ configured: false })),
}));

import { describeEnvLLMConfig } from '@libs/llm/env-llm-config';

import { GetLLMConfigStatusUseCase } from './get-llm-config-status.use-case';

describe('GetLLMConfigStatusUseCase', () => {
    const orgAndTeam = { organizationId: 'org-1', teamId: 'team-1' };

    const buildUseCase = (configValue: unknown) => {
        const organizationParametersService = {
            findByKey: jest
                .fn()
                .mockResolvedValue(
                    configValue === undefined ? null : { configValue },
                ),
        };
        return new GetLLMConfigStatusUseCase(
            organizationParametersService as any,
        );
    };

    // 04b-06: the legacy top-level {main,fallback} read is GONE. Status now derives
    // solely from the v2 shape via normalizeByokConfig (routing → model →
    // credential). The former legacy-shape Bedrock cases exercised the raw
    // `.main` read that no longer exists and were deleted.
    describe('v2 shape (credentials + models + routing)', () => {
        it('derives status from routing.defaultModelId → model → credential', async () => {
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    {
                        id: 'cred-1',
                        provider: BYOKProvider.ANTHROPIC,
                        apiKey: 'enc(sk-ant)',
                        settings: { baseURL: 'https://api.anthropic.com' },
                    },
                ],
                models: [
                    {
                        id: 'model-1',
                        credentialId: 'cred-1',
                        model: 'claude-sonnet-4-5-20250929',
                    },
                ],
                routing: { defaultModelId: 'model-1' },
            });

            const result = await useCase.execute(orgAndTeam as any);

            expect(result.byok.configured).toBe(true);
            expect(result.byok.providerId).toBe(BYOKProvider.ANTHROPIC);
            expect(result.byok.model).toBe('claude-sonnet-4-5-20250929');
            expect(result.byok.baseUrl).toBe('https://api.anthropic.com');
            expect(result.source).toBe('byok');
        });

        it('falls back to env/none when the routed default is a MANAGED credential', async () => {
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    {
                        id: 'cred-managed',
                        provider: BYOKProvider.OPENAI,
                        managed: true,
                    },
                ],
                models: [
                    {
                        id: 'model-1',
                        credentialId: 'cred-managed',
                        model: 'gpt-4o',
                    },
                ],
                routing: { defaultModelId: 'model-1' },
            });

            const result = await useCase.execute(orgAndTeam as any);

            expect(result.byok.configured).toBe(false);
            // env is stubbed not-configured in this spec → falls to 'none'.
            expect(result.source).toBe('none');
        });

        it('reports NOT configured for a v2 config with no usable model', async () => {
            const useCase = buildUseCase({
                version: 2,
                credentials: [],
                models: [],
            });

            const result = await useCase.execute(orgAndTeam as any);

            expect(result.byok.configured).toBe(false);
            expect(result.source).toBe('none');
        });
    });

    // 05-07: the status is extended to a self-host-safe, per-org, MULTI-model
    // view — it enumerates `config.models[]` and reports per-model resolvability
    // (credential present + provider set + material usable; env-default
    // reachability for a managed model), while still masking every secret and
    // never invoking a Kodus-cloud dependency.
    describe('v2 multi-model enumeration (models[])', () => {
        const twoModelConfig = {
            version: 2,
            credentials: [
                {
                    id: 'cred-anthropic',
                    provider: BYOKProvider.ANTHROPIC,
                    apiKey: 'enc(sk-ant-secret)',
                    settings: { baseURL: 'https://api.anthropic.com' },
                },
                {
                    id: 'cred-openai',
                    provider: BYOKProvider.OPENAI,
                    apiKey: 'enc(sk-openai-secret)',
                    settings: { baseURL: 'https://proxy.internal/v1' },
                },
            ],
            models: [
                {
                    id: 'model-a',
                    credentialId: 'cred-anthropic',
                    model: 'claude-sonnet-4-5-20250929',
                },
                {
                    id: 'model-b',
                    credentialId: 'cred-openai',
                    model: 'gpt-4o',
                },
            ],
            routing: { defaultModelId: 'model-a' },
        };

        it('returns one entry per configured model with per-model resolvability', async () => {
            const useCase = buildUseCase(twoModelConfig);
            const result = await useCase.execute(orgAndTeam as any);

            expect(result.models).toHaveLength(2);
            expect(result.models).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        modelId: 'model-a',
                        model: 'claude-sonnet-4-5-20250929',
                        providerId: BYOKProvider.ANTHROPIC,
                        baseUrl: 'https://api.anthropic.com',
                        resolvable: true,
                    }),
                    expect.objectContaining({
                        modelId: 'model-b',
                        model: 'gpt-4o',
                        providerId: BYOKProvider.OPENAI,
                        baseUrl: 'https://proxy.internal/v1',
                        resolvable: true,
                    }),
                ]),
            );
        });

        it('marks a model UNRESOLVABLE when its credential is missing', async () => {
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    {
                        id: 'cred-anthropic',
                        provider: BYOKProvider.ANTHROPIC,
                        apiKey: 'enc(sk-ant)',
                    },
                ],
                models: [
                    {
                        id: 'model-a',
                        credentialId: 'cred-anthropic',
                        model: 'claude-sonnet-4-5-20250929',
                    },
                    {
                        id: 'model-orphan',
                        credentialId: 'cred-gone',
                        model: 'gpt-4o',
                    },
                ],
            });

            const result = await useCase.execute(orgAndTeam as any);

            const orphan = result.models.find(
                (m) => m.modelId === 'model-orphan',
            );
            expect(orphan?.resolvable).toBe(false);
            expect(orphan?.providerId).toBeUndefined();
        });

        it('marks a model UNRESOLVABLE when the credential carries no key material', async () => {
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    {
                        id: 'cred-empty',
                        provider: BYOKProvider.OPENAI,
                        settings: {},
                    },
                ],
                models: [
                    {
                        id: 'model-a',
                        credentialId: 'cred-empty',
                        model: 'gpt-4o',
                    },
                ],
            });

            const result = await useCase.execute(orgAndTeam as any);
            expect(result.models[0].resolvable).toBe(false);
        });

        it('resolves a Bedrock model via aws credentials (no apiKey)', async () => {
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    {
                        id: 'cred-bedrock',
                        provider: BYOKProvider.AMAZON_BEDROCK,
                        settings: {
                            awsAccessKeyId: 'enc(AKIA...)',
                            awsSecretAccessKey: 'enc(secret)',
                            awsRegion: 'us-east-1',
                        },
                    },
                ],
                models: [
                    {
                        id: 'model-bedrock',
                        credentialId: 'cred-bedrock',
                        model: 'anthropic.claude-3-5-sonnet',
                    },
                ],
            });

            const result = await useCase.execute(orgAndTeam as any);
            expect(result.models[0].resolvable).toBe(true);
        });

        it('treats a MANAGED model as resolvable only when the env-default is reachable', async () => {
            const managedConfig = {
                version: 2,
                credentials: [
                    {
                        id: 'cred-managed',
                        provider: BYOKProvider.OPENAI,
                        managed: true,
                    },
                ],
                models: [
                    {
                        id: 'model-managed',
                        credentialId: 'cred-managed',
                        model: 'gpt-4o',
                    },
                ],
                routing: { defaultModelId: 'model-managed' },
            };

            (describeEnvLLMConfig as jest.Mock).mockReturnValueOnce({
                configured: true,
                model: 'gpt-4o',
                providerId: 'openai_compatible',
            });
            const reachable = await buildUseCase(managedConfig).execute(
                orgAndTeam as any,
            );
            expect(reachable.models[0].resolvable).toBe(true);

            // env stub default is { configured: false } → unreachable
            const unreachable = await buildUseCase(managedConfig).execute(
                orgAndTeam as any,
            );
            expect(unreachable.models[0].resolvable).toBe(false);
        });

        it('yields an empty models[] for a non-v2 / managed / empty config (never throws)', async () => {
            expect(
                (await buildUseCase(undefined).execute(orgAndTeam as any))
                    .models,
            ).toEqual([]);
            expect(
                (
                    await buildUseCase({
                        main: { provider: BYOKProvider.ANTHROPIC },
                    }).execute(orgAndTeam as any)
                ).models,
            ).toEqual([]);
            expect(
                (
                    await buildUseCase({
                        version: 2,
                        credentials: [],
                        models: [],
                    }).execute(orgAndTeam as any)
                ).models,
            ).toEqual([]);
        });
    });

    // 04-10: each enumerated model additionally carries a read-only `capabilities`
    // descriptor (structuredOutput / toolCalling) derived from
    // REGISTRY.get(providerId).capabilities(model) — surfaced so the Routing tab
    // can render a LIVE pre-save capability warning. It is a static descriptor
    // (NO secret) and degrades to undefined (never throws) for an unknown provider.
    describe('v2 per-model capabilities (models[].capabilities)', () => {
        it('attaches a capabilities descriptor for a registered provider model', async () => {
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    {
                        id: 'cred-anthropic',
                        provider: BYOKProvider.ANTHROPIC,
                        apiKey: 'enc(sk-ant)',
                    },
                    {
                        id: 'cred-openai',
                        provider: BYOKProvider.OPENAI,
                        apiKey: 'enc(sk-openai)',
                    },
                ],
                models: [
                    {
                        id: 'model-anthropic',
                        credentialId: 'cred-anthropic',
                        model: 'claude-sonnet-4-5-20250929',
                    },
                    {
                        id: 'model-openai',
                        credentialId: 'cred-openai',
                        model: 'gpt-4o',
                    },
                ],
                routing: { defaultModelId: 'model-anthropic' },
            });

            const result = await useCase.execute(orgAndTeam as any);

            // Anthropic does structured output via tool-use → 'none' (so it is
            // capability-INCOMPATIBLE with codeReview, the LIVE-WARNING case).
            const anthropic = result.models.find(
                (m) => m.modelId === 'model-anthropic',
            );
            expect(anthropic?.capabilities).toEqual(
                expect.objectContaining({
                    structuredOutput: 'none',
                    toolCalling: 'native',
                }),
            );

            // OpenAI: native structured output + tools → compatible with all tasks.
            const openai = result.models.find(
                (m) => m.modelId === 'model-openai',
            );
            expect(openai?.capabilities?.toolCalling).toBe('native');
            expect(['json_schema', 'json_object']).toContain(
                openai?.capabilities?.structuredOutput,
            );
        });

        it('leaves capabilities undefined for an unknown/unregistered provider (never throws)', async () => {
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    {
                        id: 'cred-unknown',
                        provider: 'totally_made_up_provider',
                        apiKey: 'enc(x)',
                    },
                ],
                models: [
                    {
                        id: 'model-unknown',
                        credentialId: 'cred-unknown',
                        model: 'mystery-model',
                    },
                ],
            });

            const result = await useCase.execute(orgAndTeam as any);
            expect(result.models[0].capabilities).toBeUndefined();
        });

        it('carries NO secret via the capabilities field', async () => {
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    {
                        id: 'cred-openai',
                        provider: BYOKProvider.OPENAI,
                        apiKey: 'enc(sk-CAPS-SECRET)',
                    },
                ],
                models: [
                    {
                        id: 'model-openai',
                        credentialId: 'cred-openai',
                        model: 'gpt-4o',
                    },
                ],
                routing: { defaultModelId: 'model-openai' },
            });

            const result = await useCase.execute(orgAndTeam as any);
            const caps = result.models[0].capabilities;
            expect(caps).toBeDefined();
            expect(JSON.stringify(caps)).not.toContain('sk-CAPS-SECRET');
            expect(JSON.stringify(caps)).not.toContain('apiKey');
        });
    });

    describe('secret hygiene + self-host safety', () => {
        it('masks every secret — no apiKey / aws* material in the serialized status', async () => {
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    {
                        id: 'cred-anthropic',
                        provider: BYOKProvider.ANTHROPIC,
                        apiKey: 'enc(sk-ant-TOP-SECRET)',
                        settings: { baseURL: 'https://api.anthropic.com' },
                    },
                    {
                        id: 'cred-bedrock',
                        provider: BYOKProvider.AMAZON_BEDROCK,
                        settings: {
                            awsAccessKeyId: 'AKIA-TOP-SECRET',
                            awsSecretAccessKey: 'aws-TOP-SECRET',
                        },
                    },
                ],
                models: [
                    {
                        id: 'model-a',
                        credentialId: 'cred-anthropic',
                        model: 'claude-sonnet-4-5-20250929',
                    },
                    {
                        id: 'model-b',
                        credentialId: 'cred-bedrock',
                        model: 'anthropic.claude-3-5-sonnet',
                    },
                ],
                routing: { defaultModelId: 'model-a' },
            });

            const result = await useCase.execute(orgAndTeam as any);
            const serialized = JSON.stringify(result);

            for (const secret of [
                'enc(sk-ant-TOP-SECRET)',
                'AKIA-TOP-SECRET',
                'aws-TOP-SECRET',
                'apiKey',
                'awsAccessKeyId',
                'awsSecretAccessKey',
                'awsBearerToken',
            ]) {
                expect(serialized).not.toContain(secret);
            }
            // metadata that IS safe to surface stays present
            expect(serialized).toContain('claude-sonnet-4-5-20250929');
            expect(serialized).toContain(BYOKProvider.ANTHROPIC);
        });

        it('makes NO outbound cloud call — reads org-params + env descriptor only', async () => {
            const originalFetch = (global as any).fetch;
            (global as any).fetch = jest.fn(() => {
                throw new Error('no network allowed in self-host status');
            });

            const organizationParametersService = {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        version: 2,
                        credentials: [
                            {
                                id: 'c1',
                                provider: BYOKProvider.ANTHROPIC,
                                apiKey: 'enc(x)',
                            },
                        ],
                        models: [
                            {
                                id: 'm1',
                                credentialId: 'c1',
                                model: 'claude-sonnet-4-5-20250929',
                            },
                        ],
                        routing: { defaultModelId: 'm1' },
                    },
                }),
            };

            const useCase = new GetLLMConfigStatusUseCase(
                organizationParametersService as any,
            );
            await useCase.execute(orgAndTeam as any);

            // Only org-params + the local env descriptor are consulted — no
            // Kodus-cloud client, no HTTP.
            expect(
                organizationParametersService.findByKey,
            ).toHaveBeenCalledTimes(1);
            expect(describeEnvLLMConfig).toHaveBeenCalled();
            expect((global as any).fetch).not.toHaveBeenCalled();

            (global as any).fetch = originalFetch;
        });
    });

    describe('env/managed/self-host default (regression)', () => {
        it('reports byok NOT configured when no BYOK parameter exists', async () => {
            const useCase = buildUseCase(undefined);

            const result = await useCase.execute(orgAndTeam as any);

            expect(result.byok.configured).toBe(false);
            expect(result.source).toBe('none');
        });

        it('reports byok NOT configured for a legacy (non-v2) blob (not read → env/none)', async () => {
            const useCase = buildUseCase({
                main: {
                    provider: BYOKProvider.ANTHROPIC,
                    model: 'claude-sonnet-4-5-20250929',
                    apiKey: 'enc(sk-ant)',
                },
            });

            const result = await useCase.execute(orgAndTeam as any);

            expect(result.byok.configured).toBe(false);
            expect(result.source).toBe('none');
        });
    });
});
