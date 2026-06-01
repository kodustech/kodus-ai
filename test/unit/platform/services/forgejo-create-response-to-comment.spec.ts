/**
 * Regression test for ForgejoService.createResponseToComment.
 *
 * Forgejo doesn't support threaded replies, so the method delegates to
 * createIssueComment. We verify the body is forwarded intact and inReplyToId
 * does not leak into the body field.
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

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

let ForgejoService: any;

describe('ForgejoService.createResponseToComment', () => {
    let forgejoService: any;
    let createIssueCommentMock: jest.Mock;

    beforeAll(async () => {
        const module = await import(
            '@libs/platform/infrastructure/adapters/services/forgejo.service'
        );
        ForgejoService = (module as any).default || module.ForgejoService;
    });

    beforeEach(async () => {
        createIssueCommentMock = jest.fn().mockResolvedValue({ id: 'forgejo-id' });

        const moduleRef = await Test.createTestingModule({
            providers: [
                ForgejoService,
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
            ],
        }).compile();

        forgejoService = moduleRef.get(ForgejoService);

        jest.spyOn(forgejoService, 'createIssueComment').mockImplementation(
            createIssueCommentMock,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    const baseParams = {
        organizationAndTeamData: {
            organizationId: 'org-uuid',
            teamId: 'team-uuid',
        },
        repository: { name: 'kodustech/kodus-ai' },
        prNumber: 7,
        inReplyToId: '1258376',
        body: 'Analyzing your request...',
    };

    it('forwards body to createIssueComment without leaking inReplyToId', async () => {
        await forgejoService.createResponseToComment(baseParams);

        expect(createIssueCommentMock).toHaveBeenCalledTimes(1);
        expect(createIssueCommentMock).toHaveBeenCalledWith({
            organizationAndTeamData: baseParams.organizationAndTeamData,
            repository: { name: 'kodustech/kodus-ai' },
            prNumber: 7,
            body: 'Analyzing your request...',
        });
        const call = createIssueCommentMock.mock.calls[0][0];
        expect(call).not.toHaveProperty('inReplyToId');
    });

    it('returns the createIssueComment response on success', async () => {
        const result = await forgejoService.createResponseToComment(baseParams);
        expect(result).toEqual({ id: 'forgejo-id' });
    });
});
