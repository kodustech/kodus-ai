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

    describe('Amazon Bedrock BYOK', () => {
        it('reports byok configured when the bearer token is set (no apiKey)', async () => {
            const useCase = buildUseCase({
                main: {
                    provider: BYOKProvider.AMAZON_BEDROCK,
                    model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                    awsBearerToken: 'enc(ABSK-token)',
                    awsRegion: 'us-east-1',
                },
            });

            const result = await useCase.execute(orgAndTeam as any);

            expect(result.byok.configured).toBe(true);
            expect(result.byok.providerId).toBe(BYOKProvider.AMAZON_BEDROCK);
            expect(result.byok.model).toBe(
                'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
            );
            expect(result.source).toBe('byok');
        });

        it('reports byok configured when IAM credentials are set (no apiKey)', async () => {
            const useCase = buildUseCase({
                main: {
                    provider: BYOKProvider.AMAZON_BEDROCK,
                    model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                    awsAccessKeyId: 'enc(AKIA-id)',
                    awsSecretAccessKey: 'enc(secret)',
                    awsRegion: 'us-east-1',
                },
            });

            const result = await useCase.execute(orgAndTeam as any);

            expect(result.byok.configured).toBe(true);
            expect(result.source).toBe('byok');
        });

        it('reports byok NOT configured when no AWS credentials are present', async () => {
            const useCase = buildUseCase({
                main: {
                    provider: BYOKProvider.AMAZON_BEDROCK,
                    model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                    awsRegion: 'us-east-1',
                },
            });

            const result = await useCase.execute(orgAndTeam as any);

            expect(result.byok.configured).toBe(false);
            expect(result.source).toBe('none');
        });

        it('reports byok NOT configured when only the access key id is present (missing secret)', async () => {
            const useCase = buildUseCase({
                main: {
                    provider: BYOKProvider.AMAZON_BEDROCK,
                    model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                    awsAccessKeyId: 'enc(AKIA-id)',
                    awsRegion: 'us-east-1',
                },
            });

            const result = await useCase.execute(orgAndTeam as any);

            expect(result.byok.configured).toBe(false);
        });
    });

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

    describe('non-Bedrock providers (regression)', () => {
        it('reports byok configured when apiKey is set', async () => {
            const useCase = buildUseCase({
                main: {
                    provider: BYOKProvider.ANTHROPIC,
                    model: 'claude-sonnet-4-5-20250929',
                    apiKey: 'enc(sk-ant)',
                },
            });

            const result = await useCase.execute(orgAndTeam as any);

            expect(result.byok.configured).toBe(true);
            expect(result.byok.providerId).toBe(BYOKProvider.ANTHROPIC);
            expect(result.source).toBe('byok');
        });

        it('reports byok NOT configured when no BYOK parameter exists', async () => {
            const useCase = buildUseCase(undefined);

            const result = await useCase.execute(orgAndTeam as any);

            expect(result.byok.configured).toBe(false);
            expect(result.source).toBe('none');
        });
    });
});
