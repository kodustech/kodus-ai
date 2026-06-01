/**
 * Regression test for the GitLab createResponseToComment argument-ordering bug.
 *
 * gitbeaker's MergeRequestDiscussions.addNote signature is:
 *   addNote(projectId, mergerequestId, discussionId, body, options?)
 *
 * Previously the service passed `inReplyToId` in the body slot and the real
 * `body` in the options slot, so the placeholder ack note ended up showing
 * the parent comment's numeric id (e.g. "1258376") instead of the
 * "Analyzing your request..." text, until updateResponseToComment ran.
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

let GitlabService: any;

describe('GitlabService.createResponseToComment', () => {
    let gitlabService: any;
    let addNoteMock: jest.Mock;

    beforeAll(async () => {
        const module = await import(
            '@libs/platform/infrastructure/adapters/services/gitlab.service'
        );
        GitlabService = (module as any).default || module.GitlabService;
    });

    beforeEach(async () => {
        addNoteMock = jest.fn().mockResolvedValue({ id: 999 });

        const moduleRef = await Test.createTestingModule({
            providers: [
                GitlabService,
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

        gitlabService = moduleRef.get(GitlabService);

        jest.spyOn(gitlabService, 'getAuthDetails').mockResolvedValue({
            token: 'test-token',
            host: 'gitlab.com',
        });
        jest.spyOn(gitlabService, 'instanceGitlabApi').mockReturnValue({
            MergeRequestDiscussions: { addNote: addNoteMock },
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
        repository: { id: 42, name: 'kodustech/kodus-ai' },
        prNumber: 7,
        discussionId: 'disc-abc',
        body: 'Analyzing your request...',
    };

    it('passes the body in the 4th argument of MergeRequestDiscussions.addNote', async () => {
        await gitlabService.createResponseToComment(baseParams);

        expect(addNoteMock).toHaveBeenCalledTimes(1);
        expect(addNoteMock).toHaveBeenCalledWith(
            42,
            7,
            'disc-abc',
            'Analyzing your request...',
        );
    });

    it('does not leak inReplyToId into the body slot when callers pass it', async () => {
        await gitlabService.createResponseToComment({
            ...baseParams,
            inReplyToId: 1258376,
        });

        const callArgs = addNoteMock.mock.calls[0];
        expect(callArgs[3]).toBe('Analyzing your request...');
        expect(callArgs).not.toContain(1258376);
    });

    it('returns the addNote response on success', async () => {
        const result = await gitlabService.createResponseToComment(baseParams);
        expect(result).toEqual({ id: 999 });
    });

    it('returns null when addNote throws', async () => {
        addNoteMock.mockRejectedValueOnce(new Error('boom'));
        const errorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);

        const result = await gitlabService.createResponseToComment(baseParams);

        expect(result).toBeNull();
        errorSpy.mockRestore();
    });
});
