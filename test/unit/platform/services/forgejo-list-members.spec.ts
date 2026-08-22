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

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: jest.fn((value: string) => value),
    encrypt: jest.fn((value: string) => value),
}));

jest.mock('@llamaduck/forgejo-ts', () => ({
    orgListCurrentUserOrgs: jest.fn(),
    orgListMembers: jest.fn(),
    userGetCurrent: jest.fn(),
}));

jest.mock('@llamaduck/forgejo-ts/client', () => ({
    createClient: jest.fn(() => ({})),
}));

/**
 * A Forgejo account with no organizations used to produce an empty member
 * list: the listing walked only the orgs the token's user belongs to, so the
 * account owner was never included and a purchased seat could not be
 * assigned to anybody.
 */

describe('ForgejoService.getListMembers', () => {
    let service: any;
    let forgejo: {
        orgListCurrentUserOrgs: jest.Mock;
        orgListMembers: jest.Mock;
        userGetCurrent: jest.Mock;
    };

    const organizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    beforeEach(async () => {
        forgejo = jest.requireMock('@llamaduck/forgejo-ts');

        const module = await import(
            '@libs/platform/infrastructure/adapters/services/forgejo.service'
        );

        const moduleRef = await Test.createTestingModule({
            providers: [
                (module as any).ForgejoService,
                { provide: ConfigService, useValue: { get: jest.fn() } },
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

        service = moduleRef.get((module as any).ForgejoService);

        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            host: 'https://git.example.com',
            accessToken: 'token',
            authMode: 'token',
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('falls back to the authenticated account owner when the token belongs to no organization', async () => {
        forgejo.orgListCurrentUserOrgs.mockResolvedValue({ data: [] });
        forgejo.userGetCurrent.mockResolvedValue({
            data: { id: 42, login: 'personal-owner', full_name: 'Personal Owner' },
        });

        const members = await service.getListMembers({
            organizationAndTeamData,
        });

        expect(members).toEqual([{ name: 'personal-owner', id: 42, type: 'user' }]);
        expect(forgejo.orgListMembers).not.toHaveBeenCalled();
    });

    it('falls back to the owner when the orgs exist but expose no members', async () => {
        forgejo.orgListCurrentUserOrgs.mockResolvedValue({
            data: [{ name: 'acme' }],
        });
        forgejo.orgListMembers.mockResolvedValue({ data: [] });
        forgejo.userGetCurrent.mockResolvedValue({
            data: { id: 42, login: 'personal-owner' },
        });

        const members = await service.getListMembers({
            organizationAndTeamData,
        });

        expect(members).toEqual([{ name: 'personal-owner', id: 42, type: 'user' }]);
    });

    it('returns org members unchanged and does not query the owner', async () => {
        forgejo.orgListCurrentUserOrgs.mockResolvedValue({
            data: [{ name: 'acme' }],
        });
        forgejo.orgListMembers.mockResolvedValue({
            data: [{ id: 1, login: 'alice', is_admin: false }],
        });

        const members = await service.getListMembers({
            organizationAndTeamData,
        });

        expect(members).toEqual([{ name: 'alice', id: 1, type: 'user' }]);
        expect(forgejo.userGetCurrent).not.toHaveBeenCalled();
    });

    it('returns an empty list when neither the orgs nor the owner resolve', async () => {
        forgejo.orgListCurrentUserOrgs.mockResolvedValue({ data: [] });
        forgejo.userGetCurrent.mockRejectedValue(new Error('401'));

        await expect(
            service.getListMembers({ organizationAndTeamData }),
        ).resolves.toEqual([]);
    });
});
