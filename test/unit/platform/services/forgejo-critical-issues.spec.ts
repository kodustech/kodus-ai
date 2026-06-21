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

const repoCreatePullReviewMock = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    repoCreatePullReview: (...args: unknown[]) =>
        repoCreatePullReviewMock(...args),
}));

jest.mock('@llamaduck/forgejo-ts/client', () => ({
    createClient: jest.fn(() => ({ mocked: true })),
}));

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: jest.fn((value: string) => value),
    encrypt: jest.fn((value: string) => value),
}));

let ForgejoService: any;

describe('ForgejoService.requestChangesPullRequest', () => {
    let service: any;

    beforeAll(async () => {
        const module = await import(
            '@libs/platform/infrastructure/adapters/services/forgejo.service'
        );
        ForgejoService = (module as any).default || module.ForgejoService;
    });

    beforeEach(async () => {
        repoCreatePullReviewMock.mockReset();

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

        service = moduleRef.get(ForgejoService);

        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            host: 'https://git.example.com/',
            accessToken: 'encrypted-token',
            authMode: 'oauth',
        });

        repoCreatePullReviewMock.mockResolvedValue({
            data: { id: 9001 },
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('links critical issue summaries back to the review comments', async () => {
        await service.requestChangesPullRequest({
            organizationAndTeamData: {
                organizationId: 'org-123',
                teamId: 'team-456',
            },
            repository: {
                id: 'repo-789',
                name: 'kodustech/kodus-ai',
            },
            prNumber: 42,
            criticalComments: [
                {
                    codeReviewFeedbackData: {
                        commentId: 7001,
                    },
                    comment: {
                        suggestion: {
                            oneSentenceSummary: 'Sanitize this input.',
                        },
                    },
                },
                {
                    codeReviewFeedbackData: {
                        commentId: 7002,
                    },
                    comment: {
                        suggestion: {
                            oneSentenceSummary: 'Handle missing token.',
                        },
                    },
                },
            ],
        });

        const body = repoCreatePullReviewMock.mock.calls[0][0].body.body;

        expect(body).toContain(
            '- [Sanitize this input.](https://git.example.com/kodustech/kodus-ai/pulls/42#issuecomment-7001)',
        );
        expect(body).toContain(
            '- [Handle missing token.](https://git.example.com/kodustech/kodus-ai/pulls/42#issuecomment-7002)',
        );
        expect(body).not.toContain('1. Sanitize this input.');
    });
});
