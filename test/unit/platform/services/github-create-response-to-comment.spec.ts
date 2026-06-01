/**
 * Regression test for GithubService.createResponseToComment.
 *
 * Verifies the body passed by callers reaches the GitHub API
 * (octokit.pulls.createReplyForReviewComment) intact, and that the
 * inReplyToId routes to the comment_id slot — never to the body slot.
 */

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { CacheService } from '@libs/core/cache/cache.service';
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

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

let GithubService: any;

describe('GithubService.createResponseToComment', () => {
    let githubService: any;
    let createReplyMock: jest.Mock;

    beforeAll(async () => {
        const module = await import(
            '@libs/platform/infrastructure/adapters/services/github/github.service'
        );
        GithubService = (module as any).default || module.GithubService;
    });

    beforeEach(async () => {
        createReplyMock = jest
            .fn()
            .mockResolvedValue({ data: { id: 'reply-id' } });

        const moduleRef = await Test.createTestingModule({
            providers: [
                GithubService,
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
                    provide: CacheService,
                    useValue: { get: jest.fn(), set: jest.fn() },
                },
                {
                    provide: MCPManagerService,
                    useValue: { getManager: jest.fn() },
                },
            ],
        }).compile();

        githubService = moduleRef.get(GithubService);

        jest.spyOn(githubService, 'getGithubAuthDetails').mockResolvedValue({
            org: 'acme',
        });
        jest.spyOn(githubService, 'instanceOctokit').mockResolvedValue({
            pulls: { createReplyForReviewComment: createReplyMock },
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    const baseParams = {
        organizationAndTeamData: {
            organizationId: 'org-uuid',
            teamId: 'team-uuid',
        },
        repository: { id: 'repo-id', name: 'kodus-ai' },
        prNumber: 42,
        inReplyToId: 1258376,
        body: 'Analyzing your request...',
    };

    it('routes body and inReplyToId to the correct fields of createReplyForReviewComment', async () => {
        await githubService.createResponseToComment(baseParams);

        expect(createReplyMock).toHaveBeenCalledTimes(1);
        expect(createReplyMock).toHaveBeenCalledWith({
            owner: 'acme',
            repo: 'kodus-ai',
            pull_number: 42,
            comment_id: 1258376,
            body: 'Analyzing your request...',
        });
    });

    it('returns the API response data on success', async () => {
        const result = await githubService.createResponseToComment(baseParams);
        expect(result).toEqual({ id: 'reply-id' });
    });
});
