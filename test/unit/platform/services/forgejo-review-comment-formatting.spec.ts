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

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: jest.fn((value: string) => value),
    encrypt: jest.fn((value: string) => value),
}));

const repoCreatePullReviewMock = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    repoCreatePullReview: (...args: unknown[]) =>
        repoCreatePullReviewMock(...args),
}));

jest.mock('@llamaduck/forgejo-ts/client', () => ({
    createClient: jest.fn(() => ({ mocked: true })),
}));

let ForgejoService: any;

describe('ForgejoService review comment formatting', () => {
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
            host: 'https://git.example.com',
            accessToken: 'encrypted-token',
            authMode: 'oauth',
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('includes the suggestion llm prompt by default when formatting review comments', async () => {
        const body = await service.formatReviewCommentBody({
            suggestion: {
                suggestionContent: 'Sanitize this input.',
                improvedCode: 'const value = sanitize(input);',
                llmPrompt: 'Explain why sanitization is required here.',
                language: 'typescript',
                label: 'security',
                severity: 'high',
            },
            repository: {
                name: 'kodustech/kodus-ai',
                language: 'typescript',
            },
            language: 'en-US',
            organizationAndTeamData: {
                organizationId: 'org-123',
                teamId: 'team-456',
            },
        });

        expect(body).toContain('Sanitize this input.');
        expect(body).toContain('<summary>Prompt for LLM</summary>');
        expect(body).toContain(
            'Explain why sanitization is required here.',
        );
        expect(body).toContain(
            'Suggested Code:\n\nconst value = sanitize(input);',
        );
    });

    it('creates review comments with prompt copy enabled by default', async () => {
        repoCreatePullReviewMock.mockResolvedValue({
            data: {
                id: 9001,
                submitted_at: '2024-01-16T10:00:00Z',
                comments: [
                    {
                        id: 7001,
                        body: 'comment body',
                        created_at: '2024-01-16T10:00:00Z',
                        updated_at: '2024-01-16T10:00:00Z',
                    },
                ],
            },
        });

        const result = await service.createReviewComment({
            organizationAndTeamData: {
                organizationId: 'org-123',
                teamId: 'team-456',
            },
            repository: {
                name: 'kodustech/kodus-ai',
                language: 'typescript',
            },
            prNumber: 42,
            language: 'en-US',
            lineComment: {
                path: 'src/example.ts',
                line: 12,
                suggestion: {
                    llmPrompt: 'Explain why sanitization is required here.',
                    language: 'typescript',
                    label: 'security',
                    severity: 'high',
                },
                body: {
                    suggestionContent: 'Sanitize this input.',
                    improvedCode: 'const value = sanitize(input);',
                },
            },
        });

        const request = repoCreatePullReviewMock.mock.calls[0][0];

        expect(request.body.comments[0].body).toContain(
            '<summary>Prompt for LLM</summary>',
        );
        expect(request.body.comments[0].body).toContain(
            'Explain why sanitization is required here.',
        );
        expect(result).toEqual(
            expect.objectContaining({
                id: 7001,
                pullRequestReviewId: '9001',
                body: 'comment body',
                createdAt: '2024-01-16T10:00:00Z',
                updatedAt: '2024-01-16T10:00:00Z',
            }),
        );
    });
});
