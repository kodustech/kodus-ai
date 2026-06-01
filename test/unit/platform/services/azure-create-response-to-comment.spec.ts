/**
 * Regression test for AzureReposService.createResponseToComment.
 *
 * Verifies the body reaches the `comment` field of the Azure helper's
 * replyToThreadComment, and that thread/repo/auth identifiers route to
 * the correct fields — never accidentally mixed with the body.
 */

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
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import { AzureReposRequestHelper } from '@libs/platform/infrastructure/adapters/services/azureRepos/azure-repos-request-helper';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

let AzureReposService: any;

describe('AzureReposService.createResponseToComment', () => {
    let azureReposService: any;
    let replyToThreadCommentMock: jest.Mock;

    beforeAll(async () => {
        const module = await import(
            '@libs/platform/infrastructure/adapters/services/azureRepos/azureRepos.service'
        );
        AzureReposService = (module as any).default || module.AzureReposService;
    });

    beforeEach(async () => {
        replyToThreadCommentMock = jest
            .fn()
            .mockResolvedValue({ id: 'azure-reply-id' });

        const moduleRef = await Test.createTestingModule({
            providers: [
                AzureReposService,
                {
                    provide: ConfigService,
                    useValue: { get: jest.fn() },
                },
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
                {
                    provide: AzureReposRequestHelper,
                    useValue: { replyToThreadComment: replyToThreadCommentMock },
                },
                {
                    provide: MCPManagerService,
                    useValue: { getManager: jest.fn() },
                },
            ],
        }).compile();

        azureReposService = moduleRef.get(AzureReposService);

        jest.spyOn(azureReposService, 'getAuthDetails').mockResolvedValue({
            orgName: 'acme',
            token: 'azure-token',
        });
        jest.spyOn(azureReposService as any, 'getProjectIdFromRepository').mockResolvedValue('project-uuid');
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    const baseParams = {
        organizationAndTeamData: {
            organizationId: 'org-uuid',
            teamId: 'team-uuid',
        },
        repository: { id: 'repo-uuid', name: 'kodus-ai' },
        prNumber: 7,
        threadId: 99,
        body: 'Analyzing your request...',
    };

    it('routes body to the comment field and threadId to threadId', async () => {
        await azureReposService.createResponseToComment(baseParams);

        expect(replyToThreadCommentMock).toHaveBeenCalledTimes(1);
        expect(replyToThreadCommentMock).toHaveBeenCalledWith({
            orgName: 'acme',
            token: 'azure-token',
            projectId: 'project-uuid',
            repositoryId: 'repo-uuid',
            prId: 7,
            threadId: 99,
            comment: 'Analyzing your request...',
        });
    });

    it('returns the helper response on success', async () => {
        const result = await azureReposService.createResponseToComment(baseParams);
        expect(result).toEqual({ id: 'azure-reply-id' });
    });

    it('returns null when the helper throws', async () => {
        replyToThreadCommentMock.mockRejectedValueOnce(new Error('boom'));
        const result = await azureReposService.createResponseToComment(baseParams);
        expect(result).toBeNull();
    });
});
