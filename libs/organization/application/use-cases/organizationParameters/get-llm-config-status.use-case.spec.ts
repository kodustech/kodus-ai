import { BYOKProvider } from '@kodus/kodus-common/llm';

// Keep the env-LLM branch deterministic: these tests exercise the BYOK
// detection logic, so env is always "not configured" here.
jest.mock('@libs/llm/env-llm-config', () => ({
    describeEnvLLMConfig: jest.fn(() => ({ configured: false })),
}));

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
