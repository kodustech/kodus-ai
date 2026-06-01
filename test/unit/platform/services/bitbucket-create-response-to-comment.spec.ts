/**
 * Regression test for BitbucketService.createResponseToComment.
 *
 * Verifies the body and inReplyToId reach the right slots of the Bitbucket
 * API (pullrequests.createComment): body goes into _body.content.raw and
 * inReplyToId goes into _body.parent.id.
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

let BitbucketService: any;
let BitbucketCloudService: any;
let BitbucketDataCenterService: any;

describe('BitbucketService.createResponseToComment', () => {
    let bitbucketService: any;
    let bitbucketCloudService: any;
    let bitbucketDataCenterService: any;
    let createCommentMock: jest.Mock;

    beforeAll(async () => {
        const module =
            await import('@libs/platform/infrastructure/adapters/services/bitbucket.service');
        BitbucketService = (module as any).default || module.BitbucketService;
        const cloudModule =
            await import('@libs/platform/infrastructure/adapters/services/bitbucket/bitbucket-cloud.service');
        BitbucketCloudService =
            (cloudModule as any).default || cloudModule.BitbucketCloudService;
        const dataCenterModule =
            await import('@libs/platform/infrastructure/adapters/services/bitbucket/bitbucket-data-center.service');
        BitbucketDataCenterService =
            (dataCenterModule as any).default ||
            dataCenterModule.BitbucketDataCenterService;
    });

    beforeEach(async () => {
        createCommentMock = jest
            .fn()
            .mockResolvedValue({ data: { id: 'comment-id' } });

        const moduleRef = await Test.createTestingModule({
            providers: [
                BitbucketService,
                BitbucketCloudService,
                BitbucketDataCenterService,
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

        bitbucketService = moduleRef.get(BitbucketService);
        bitbucketCloudService = moduleRef.get(BitbucketCloudService);
        bitbucketDataCenterService = moduleRef.get(BitbucketDataCenterService);

        jest.spyOn(bitbucketCloudService, 'getAuthDetails').mockResolvedValue(
            {},
        );
        jest.spyOn(
            bitbucketCloudService,
            'getWorkspaceFromRepository',
        ).mockResolvedValue('workspace-uuid');
        jest.spyOn(
            bitbucketCloudService,
            'instanceBitbucketApi',
        ).mockReturnValue({
            pullrequests: { createComment: createCommentMock },
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
        repository: { id: 'repo-uuid', name: 'kodus-ai' },
        prNumber: 7,
        inReplyToId: 1258376,
        body: 'Analyzing your request...',
    };

    it('routes body to _body.content.raw and inReplyToId to _body.parent.id', async () => {
        await bitbucketService.createResponseToComment(baseParams);

        expect(createCommentMock).toHaveBeenCalledTimes(1);
        const call = createCommentMock.mock.calls[0][0];
        expect(call.pull_request_id).toBe(7);
        expect(call.repo_slug).toBe('{repo-uuid}');
        expect(call.workspace).toBe('{workspace-uuid}');
        expect(call._body.content.raw).toBe('Analyzing your request...');
        expect(call._body.parent.id).toBe(1258376);
    });

    it('returns the API response data on success', async () => {
        const result =
            await bitbucketService.createResponseToComment(baseParams);
        expect(result).toEqual({ id: 'comment-id' });
    });

    it('returns null when the API call throws', async () => {
        createCommentMock.mockRejectedValueOnce(new Error('boom'));
        const result =
            await bitbucketService.createResponseToComment(baseParams);
        expect(result).toBeNull();
    });
});
