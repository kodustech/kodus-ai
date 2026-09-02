// @ts-nocheck
import { OrganizationParametersController } from '../organizationParameters.controller';

/**
 * Route-level contract for POST /organization-parameters/test-byok.
 *
 * The connection probe only proves the config being SAVED if every field the
 * save persists actually reaches it. That chain is form → controller → use-case,
 * and the controller's typed body is the narrow point: a field missing there is
 * dropped silently, the probe runs a weaker config than the one stored, and
 * nothing fails until the first review. These assertions pin the passthrough so
 * the tuning fields can't be lost the way they were before they were plumbed.
 */
describe('OrganizationParametersController.testByokConnection — body passthrough', () => {
    let controller: OrganizationParametersController;
    let testByokConnectionUseCase: { execute: jest.Mock };

    beforeEach(() => {
        testByokConnectionUseCase = {
            execute: jest
                .fn()
                .mockResolvedValue({ ok: true, code: 'ok', latencyMs: 5 }),
        };
        // Only testByokConnectionUseCase (arg 9) is exercised by this route.
        controller = new OrganizationParametersController(
            undefined as any, // createOrUpdateOrganizationParametersUseCase
            undefined as any, // findByKeyOrganizationParametersUseCase
            undefined as any, // getModelsByProviderUseCase
            undefined as any, // getModelCapabilitiesUseCase
            undefined as any, // providerService
            undefined as any, // deleteByokConfigUseCase
            undefined as any, // getLLMConfigStatusUseCase
            undefined as any, // getByokProvidersUseCase
            testByokConnectionUseCase as any,
            undefined as any, // testByokModelUseCase
            undefined as any, // listModelOverridesUseCase
            undefined as any, // clearModelOverridesUseCase
            undefined as any, // getCockpitMetricsVisibilityUseCase
            undefined as any, // ignoreBotsUseCase
            undefined as any, // updateAutoLicenseAllowedUsersUseCase
            {} as any, // request
        );
    });

    it('forwards the advanced tuning, not just credentials and model', async () => {
        const body = {
            provider: 'open_router',
            apiKey: 'sk-test',
            baseURL: 'https://openrouter.ai/api/v1',
            model: 'anthropic/claude-x',
            temperature: 0.3,
            reasoningEffort: 'high' as const,
            reasoningConfigOverride: '{"reasoning":{"effort":"high"}}',
            maxOutputTokens: 2048,
            openrouterProviderOrder: ['anthropic'],
            openrouterAllowFallbacks: false,
        };

        await controller.testByokConnection(body);

        expect(testByokConnectionUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                reasoningConfigOverride: '{"reasoning":{"effort":"high"}}',
                maxOutputTokens: 2048,
                openrouterProviderOrder: ['anthropic'],
                openrouterAllowFallbacks: false,
                temperature: 0.3,
                reasoningEffort: 'high',
            }),
        );
    });

    it('forwards the provider-specific credential fields untouched', async () => {
        const body = {
            provider: 'amazon_bedrock',
            model: 'anthropic.claude-x',
            awsBearerToken: 'bearer-token',
            awsAccessKeyId: 'AKIA',
            awsSecretAccessKey: 'secret',
            awsRegion: 'us-east-1',
            awsSessionToken: 'session',
            vertexLocation: 'global',
        };

        await controller.testByokConnection(body as any);

        expect(testByokConnectionUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                awsBearerToken: 'bearer-token',
                awsAccessKeyId: 'AKIA',
                awsSecretAccessKey: 'secret',
                awsRegion: 'us-east-1',
                awsSessionToken: 'session',
                vertexLocation: 'global',
            }),
        );
    });

    it('returns the probe verdict as-is', async () => {
        testByokConnectionUseCase.execute.mockResolvedValue({
            ok: false,
            code: 'auth',
            latencyMs: 12,
            message: 'rejected',
        });

        await expect(
            controller.testByokConnection({
                provider: 'openai',
                apiKey: 'sk-bad',
                model: 'gpt-x',
            }),
        ).resolves.toEqual({
            ok: false,
            code: 'auth',
            latencyMs: 12,
            message: 'rejected',
        });
    });
});
