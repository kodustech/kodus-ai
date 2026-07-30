// Mock heavy transitive dependencies BEFORE importing the controller
jest.mock(
    '@libs/cli-review/application/use-cases/execute-cli-review.use-case',
    () => ({ ExecuteCliReviewUseCase: class {} }),
);
jest.mock(
    '@libs/cli-review/application/use-cases/submit-cli-session-capture.use-case',
    () => ({ SubmitCliSessionCaptureUseCase: class {} }),
);
jest.mock(
    '@libs/cli-review/infrastructure/services/authenticated-rate-limiter.service',
    () => ({ AuthenticatedRateLimiterService: class {} }),
);
jest.mock(
    '@libs/cli-review/infrastructure/services/trial-rate-limiter.service',
    () => ({ TrialRateLimiterService: class {} }),
);
jest.mock(
    '@libs/cli-review/application/use-cases/ingest-session-event.use-case',
    () => ({ IngestSessionEventUseCase: class {} }),
);

import { UnauthorizedException } from '@nestjs/common';
import { CliReviewController } from '../cli/cli-review.controller';
import { ValidateCliKeyUseCase } from '@libs/cli-review/application/use-cases/validate-cli-key.use-case';

describe('CliReviewController.ingestSessionEvent', () => {
    let controller: CliReviewController;
    let ingestUseCase: { execute: jest.Mock };
    let teamCliKeyService: { validateKey: jest.Mock };
    let authenticatedRateLimiter: { checkRateLimit: jest.Mock };

    beforeEach(() => {
        ingestUseCase = {
            execute: jest.fn().mockResolvedValue({ accepted: true }),
        };

        teamCliKeyService = {
            validateKey: jest.fn().mockResolvedValue({
                team: { uuid: 'team-1', name: 'T1' },
                organization: { uuid: 'org-1', name: 'O1' },
            }),
        };

        authenticatedRateLimiter = {
            checkRateLimit: jest
                .fn()
                .mockResolvedValue({ allowed: true, remaining: 999 }),
        };

        // Construct the real use case against the same mocked services
        // so the auth flow inside ingestSessionEvent still resolves
        // through `teamCliKeyService.validateKey` like before.
        const validateCliKeyUseCase = new ValidateCliKeyUseCase(
            teamCliKeyService as any,
            {} as any, // teamService — JWT path not exercised here
            {} as any, // authService
            {} as any, // cliDeviceService
            {} as any, // jwtService
            { get: () => ({ secret: 'test' }) } as any,
        );

        controller = new CliReviewController(
            {} as any, // executeCliReviewUseCase
            { execute: jest.fn() } as any, // enqueueCliReviewUseCase
            { execute: jest.fn() } as any, // getCliReviewJobStatusUseCase
            { execute: jest.fn() } as any, // waitForCliReviewJobUseCase
            ingestUseCase as any, // ingestSessionEventUseCase
            {} as any, // submitCliSessionCaptureUseCase
            {} as any, // trialRateLimiter
            authenticatedRateLimiter as any, // authenticatedRateLimiter
            {} as any, // githubPublicPrService
            {} as any, // publicPrReviewUseCase
            {} as any, // listFeaturedPublicReviewsUseCase
            {} as any, // getFeaturedPublicReviewUseCase
            validateCliKeyUseCase as any, // validateCliKeyUseCase
            teamCliKeyService as any, // teamCliKeyService
            {} as any, // teamService
            {} as any, // authService
            {} as any, // cliDeviceService
            {} as any, // triggerBusinessValidationUseCase
            {} as any, // jwtService
            { get: () => ({ secret: 'test' }) } as any, // configService
        );
    });

    it('authenticates with team key and delegates to use case', async () => {
        const body = {
            sessionId: 'sess-1',
            type: 'session_start' as const,
            branch: 'main',
            timestamp: '2025-06-01T10:00:00.000Z',
            agentType: 'claude-code',
            gitRemote: 'git@github.com:org/repo.git',
        };

        const result = await controller.ingestSessionEvent(
            { body },
            'kodus_test_key',
            undefined,
            undefined,
        );

        expect(result).toEqual({ accepted: true });
        expect(teamCliKeyService.validateKey).toHaveBeenCalledWith(
            'kodus_test_key',
        );
        expect(ingestUseCase.execute).toHaveBeenCalledWith({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            event: {
                sessionId: 'sess-1',
                type: 'session_start',
                branch: 'main',
                timestamp: '2025-06-01T10:00:00.000Z',
                agentType: 'claude-code',
                gitRemote: 'git@github.com:org/repo.git',
            },
        });
    });

    it('passes extra payload fields through to event', async () => {
        const body = {
            sessionId: 'sess-1',
            type: 'turn_start' as const,
            branch: 'main',
            timestamp: '2025-06-01T10:00:00.000Z',
            prompt: 'Fix the bug',
            customField: 42,
        };

        await controller.ingestSessionEvent(
            { body },
            'kodus_key',
            undefined,
            undefined,
        );

        expect(ingestUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                event: expect.objectContaining({
                    prompt: 'Fix the bug',
                    customField: 42,
                }),
            }),
        );
    });

    it('throws UnauthorizedException when team key is invalid', async () => {
        teamCliKeyService.validateKey.mockResolvedValue(null);

        const body = {
            sessionId: 'sess-1',
            type: 'session_start' as const,
            branch: 'main',
            timestamp: '2025-06-01T10:00:00.000Z',
        };

        await expect(
            controller.ingestSessionEvent(
                { body },
                'bad_key',
                undefined,
                undefined,
            ),
        ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when no auth is provided', async () => {
        const body = {
            sessionId: 'sess-1',
            type: 'session_start' as const,
            branch: 'main',
            timestamp: '2025-06-01T10:00:00.000Z',
        };

        await expect(
            controller.ingestSessionEvent(
                { body },
                undefined,
                undefined,
                undefined,
            ),
        ).rejects.toThrow(UnauthorizedException);
    });

    it('authenticates via Bearer kodus_ prefix', async () => {
        const body = {
            sessionId: 'sess-1',
            type: 'session_end' as const,
            branch: 'main',
            timestamp: '2025-06-01T10:00:00.000Z',
        };

        await controller.ingestSessionEvent(
            { body },
            undefined,
            'Bearer kodus_my_key',
            undefined,
        );

        expect(teamCliKeyService.validateKey).toHaveBeenCalledWith(
            'kodus_my_key',
        );
        expect(ingestUseCase.execute).toHaveBeenCalled();
    });

    it('returns use case result as-is', async () => {
        ingestUseCase.execute.mockResolvedValue({
            accepted: true,
            uuid: 'evt-1',
        });

        const body = {
            sessionId: 'sess-1',
            type: 'session_start' as const,
            branch: 'main',
            timestamp: '2025-06-01T10:00:00.000Z',
        };

        const result = await controller.ingestSessionEvent(
            { body },
            'kodus_key',
            undefined,
            undefined,
        );
        expect(result).toEqual({ accepted: true, uuid: 'evt-1' });
    });
});
