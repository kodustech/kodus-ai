import { ConfigService } from '@nestjs/config';
import { userGetCurrent } from '@llamaduck/forgejo-ts';

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { BitbucketDataCenterService } from './bitbucket/bitbucket-data-center.service';
import { ForgejoService } from './forgejo.service';
import { GitlabService } from './gitlab.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

jest.mock('@llamaduck/forgejo-ts', () => ({
    userGetCurrent: jest.fn(),
}));

const organizationAndTeamData = {
    organizationId: 'org-1',
    teamId: 'team-1',
};

const configService = { get: jest.fn() } as unknown as ConfigService;

describe('self-hosted connection status', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('exposes the stored GitLab host without exposing the token', async () => {
        const integrationService = {
            findOne: jest.fn().mockResolvedValue({
                authIntegration: {
                    authDetails: {
                        accessToken: 'secret-token',
                        authMode: AuthMode.TOKEN,
                        host: 'https://gitlab.example.com',
                    },
                },
            }),
        };
        const service = new GitlabService(
            integrationService as any,
            {} as any,
            {} as any,
            configService,
            {} as any,
        );
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue([]);

        const status = await service.verifyConnection({
            organizationAndTeamData,
        });

        expect(status.config).toMatchObject({
            host: 'https://gitlab.example.com',
        });
        expect(status.config).not.toHaveProperty('accessToken');
    });

    it('exposes the stored Bitbucket Data Center host without credentials', async () => {
        const integrationService = {
            findOne: jest.fn().mockResolvedValue({
                authIntegration: {
                    authDetails: {
                        appPassword: 'secret-token',
                        host: 'https://bitbucket.example.com',
                    },
                },
            }),
        };
        const service = new BitbucketDataCenterService(
            integrationService as any,
            {} as any,
            {} as any,
            configService,
        );
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue({ configValue: [] });

        const status = await service.verifyConnection({
            organizationAndTeamData,
        });

        expect(status.config).toMatchObject({
            host: 'https://bitbucket.example.com',
        });
        expect(status.config).not.toHaveProperty('appPassword');
    });

    it('exposes the verified Forgejo host without exposing the token', async () => {
        const service = new ForgejoService(
            {} as any,
            {} as any,
            {} as any,
            configService,
        );
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            accessToken: 'secret-token',
            host: 'https://forgejo.example.com',
        });
        jest.spyOn(service, 'createForgejoClient').mockReturnValue({} as any);
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue([]);
        (userGetCurrent as jest.Mock).mockResolvedValue({ data: {} });

        const status = await service.verifyConnection({
            organizationAndTeamData,
        });

        expect(status.config).toMatchObject({
            host: 'https://forgejo.example.com',
        });
        expect(status.config).not.toHaveProperty('accessToken');
    });
});
