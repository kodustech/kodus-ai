import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

const repoListHooksMock = jest.fn();
const repoCreateHookMock = jest.fn();
const repoEditHookMock = jest.fn();

jest.mock('@llamaduck/forgejo-ts/client', () => ({
    createClient: jest.fn(() => ({ mocked: true })),
}));

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: jest.fn((value: string) => value),
    encrypt: jest.fn((value: string) => value),
}));

let ForgejoService: any;
const repoGetAllCommitsMock = jest.fn();
const repoGetMock = jest.fn();
const repoDeleteHookMock = jest.fn();
jest.mock('@llamaduck/forgejo-ts', () => ({
    repoListHooks: (...args: unknown[]) => repoListHooksMock(...args),
    repoCreateHook: (...args: unknown[]) => repoCreateHookMock(...args),
    repoEditHook: (...args: unknown[]) => repoEditHookMock(...args),
    repoGetAllCommits: (...args: unknown[]) => repoGetAllCommitsMock(...args),
    repoGet: (...args: unknown[]) => repoGetMock(...args),
    repoDeleteHook: (...args: unknown[]) => repoDeleteHookMock(...args),
}));

const URL = 'https://api.example.com/forgejo/webhook';

/**
 * Regression: isWebhookActive, deleteWebhook and diagnoseRepositoryAccess read
 * FORGEJO_WEBHOOK_URL, a variable set nowhere; the hook is created from
 * API_FORGEJO_CODE_MANAGEMENT_WEBHOOK, so the status always read "inactive"
 * and the doctor could never confirm a Forgejo hook.
 */
describe('ForgejoService webhook URL variable', () => {
    let service: any;

    beforeAll(async () => {
        const module =
            await import('@libs/platform/infrastructure/adapters/services/forgejo.service');
        ForgejoService = (module as any).default || module.ForgejoService;
    });

    beforeEach(async () => {
        repoListHooksMock.mockReset();
        repoGetAllCommitsMock.mockReset();
        repoGetMock.mockReset();
        repoDeleteHookMock.mockReset();
        const configService = {
            // only the variable the hook is created from is set
            get: jest.fn((key: string) =>
                key === 'API_FORGEJO_CODE_MANAGEMENT_WEBHOOK' ? URL : undefined,
            ),
        };
        const moduleRef = await Test.createTestingModule({
            providers: [
                ForgejoService,
                { provide: ConfigService, useValue: configService },
                {
                    provide: INTEGRATION_SERVICE_TOKEN,
                    useValue: {
                        findOne: jest.fn(),
                    } as Partial<IIntegrationService>,
                },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: {
                        findOne: jest.fn(),
                    } as Partial<IIntegrationConfigService>,
                },
                {
                    provide: AUTH_INTEGRATION_SERVICE_TOKEN,
                    useValue: {
                        findOne: jest.fn(),
                    } as Partial<IAuthIntegrationService>,
                },
            ],
        }).compile();
        service = moduleRef.get(ForgejoService);
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            host: 'https://git.example.com',
            accessToken: 'encrypted-token',
            authMode: 'token',
        });
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue([{ id: '22', name: 'kodustech/kodus-ai' }]);
        repoListHooksMock.mockResolvedValue({
            data: [{ active: true, config: { url: URL } }],
        });
    });

    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };

    it('isWebhookActive finds the hook created from API_FORGEJO_CODE_MANAGEMENT_WEBHOOK', async () => {
        await expect(
            service.isWebhookActive({
                organizationAndTeamData: orgTeam,
                repositoryId: '22',
            }),
        ).resolves.toBe(true);
    });

    it('diagnoseRepositoryAccess reports that hook as present', async () => {
        repoGetAllCommitsMock.mockResolvedValue({ data: [{}] });
        repoGetMock.mockResolvedValue({
            data: { permissions: { push: true, pull: true } },
        });
        const d = await service.diagnoseRepositoryAccess({
            organizationAndTeamData: orgTeam,
            repository: {
                id: '22',
                name: 'kodustech/kodus-ai',
                fullName: 'kodustech/kodus-ai',
            },
        });
        expect(d.hook).toBe('present');
    });

    it('deleteWebhook removes only the hook with the configured URL', async () => {
        repoListHooksMock.mockResolvedValue({
            data: [
                { id: 1, active: true, config: { url: URL } },
                {
                    id: 2,
                    active: true,
                    config: { url: 'https://other.example/hook' },
                },
                { id: 3, active: true, config: {} },
            ],
        });
        await service.deleteWebhook({ organizationAndTeamData: orgTeam });
        expect(repoDeleteHookMock).toHaveBeenCalledTimes(1);
        expect(repoDeleteHookMock.mock.calls[0][0].path.id).toBe(1);
    });

    describe('webhook URL not configured', () => {
        beforeEach(() => {
            (service as any).configService.get.mockReturnValue(undefined);
            repoListHooksMock.mockResolvedValue({
                data: [{ id: 3, active: true, config: {} }],
            });
        });

        it('isWebhookActive is false, even for a hook without a URL', async () => {
            await expect(
                service.isWebhookActive({
                    organizationAndTeamData: orgTeam,
                    repositoryId: '22',
                }),
            ).resolves.toBe(false);
        });

        it('diagnoseRepositoryAccess does not report a hook as present', async () => {
            repoGetAllCommitsMock.mockResolvedValue({ data: [{}] });
            repoGetMock.mockResolvedValue({
                data: { permissions: { push: true, pull: true } },
            });
            const d = await service.diagnoseRepositoryAccess({
                organizationAndTeamData: orgTeam,
                repository: {
                    id: '22',
                    name: 'kodustech/kodus-ai',
                    fullName: 'kodustech/kodus-ai',
                },
            });
            expect(d.hook).not.toBe('present');
        });

        it('deleteWebhook deletes nothing (never matches hooks without a URL)', async () => {
            await service.deleteWebhook({ organizationAndTeamData: orgTeam });
            expect(repoDeleteHookMock).not.toHaveBeenCalled();
        });
    });
});
