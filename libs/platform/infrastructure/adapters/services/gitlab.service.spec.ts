import { ConfigService } from '@nestjs/config';
import { Gitlab } from '@gitbeaker/rest';
import axios from 'axios';

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { GitlabService } from './gitlab.service';

jest.mock('axios');
jest.mock('@gitbeaker/rest', () => ({
    Gitlab: jest.fn(),
}));
jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

describe('GitlabService', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    let service: GitlabService;
    let integrationService: { findOne: jest.Mock };
    let integrationConfigService: Record<string, never>;
    let authIntegrationService: Record<string, never>;
    let configService: ConfigService;
    let cacheService: Record<string, never>;

    const mockedAxios = axios as jest.Mocked<typeof axios>;
    const mockedGitlab = Gitlab as unknown as jest.Mock;

    beforeEach(() => {
        integrationService = {
            findOne: jest.fn().mockResolvedValue({ uuid: 'integration-1' }),
        };
        integrationConfigService = {};
        authIntegrationService = {};
        configService = {
            get: jest.fn(),
        } as unknown as ConfigService;
        cacheService = {};

        service = new GitlabService(
            integrationService as any,
            integrationConfigService as any,
            authIntegrationService as any,
            configService,
            cacheService as any,
        );

        jest.clearAllMocks();
    });

    it('normalizes bare stored hosts before creating the GitLab API client', () => {
        (service as any).instanceGitlabApi({
            accessToken: 'oauth-token',
            authMode: AuthMode.OAUTH,
            host: 'gitlab.example.com/',
        });

        expect(mockedGitlab).toHaveBeenCalledWith({
            oauthToken: 'oauth-token',
            host: 'https://gitlab.example.com',
            queryTimeout: 600000,
            camelize: false,
        });
    });

    it('normalizes bare self-hosted GitLab hosts when authenticating with a token', async () => {
        mockedAxios.get.mockResolvedValue({ data: { id: 1 } });
        const checkRepositoryPermissions = jest
            .spyOn(service as any, 'checkRepositoryPermissions')
            .mockResolvedValue({ success: true });
        jest.spyOn(service as any, 'handleIntegration').mockResolvedValue(
            undefined,
        );

        await service.authenticateWithToken({
            token: 'pat-token',
            host: 'gitlab.example.com/',
            authMode: AuthMode.TOKEN,
            organizationAndTeamData,
        });

        expect(mockedAxios.get).toHaveBeenCalledWith(
            'https://gitlab.example.com/api/v4/user',
            expect.objectContaining({
                headers: { Authorization: 'Bearer pat-token' },
                timeout: 30000,
            }),
        );
        expect(checkRepositoryPermissions).toHaveBeenCalledWith({
            authDetails: expect.objectContaining({
                authMode: AuthMode.TOKEN,
                host: 'https://gitlab.example.com',
            }),
        });
    });

    it('does not duplicate the protocol when building clone params for self-hosted GitLab', async () => {
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            accessToken: 'oauth-token',
            authMode: AuthMode.OAUTH,
            host: 'https://gitlab.example.com/',
        });

        const cloneParams = await service.getCloneParams({
            organizationAndTeamData,
            repository: {
                id: 'repo-1',
                name: 'repo',
                fullName: 'group/repo',
                defaultBranch: 'main',
            },
        });

        expect(cloneParams.url).toBe('https://gitlab.example.com/group/repo');
        expect(cloneParams.auth).toMatchObject({
            type: AuthMode.OAUTH,
            token: 'oauth-token',
        });
    });
});
