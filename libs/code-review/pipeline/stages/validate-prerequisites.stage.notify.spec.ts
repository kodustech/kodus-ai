import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { Test, TestingModule } from '@nestjs/testing';

import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PlatformType } from '@libs/core/domain/enums';
import { ORGANIZATION_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { AutoAssignLicenseUseCase } from '@libs/ee/license/use-cases/auto-assign-license.use-case';
import { LICENSE_SERVICE_TOKEN } from '@libs/ee/license/interfaces/license.interface';
import {
    PermissionValidationService,
    ValidationErrorType,
} from '@libs/ee/shared/services/permissionValidation.service';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationRateLimiter } from '@libs/notifications/application/notification-rate-limiter.service';
import { PrAuthorRecipientResolver } from '@libs/notifications/application/pr-author-recipient.resolver';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { USER_SERVICE_TOKEN } from '@libs/identity/domain/user/contracts/user.service.contract';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { ValidatePrerequisitesStage } from './validate-prerequisites.stage';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

/**
 * Drives the stage into its USER_NOT_LICENSED branch with auto-assign
 * disabled. Other paths (centralized config skip, locked PR, ignored
 * users, etc.) are covered by validate-prerequisites.stage.spec.ts;
 * this file focuses exclusively on the notification side-effect.
 */
describe('ValidatePrerequisitesStage — review.skipped_no_license emit', () => {
    let stage: ValidatePrerequisitesStage;
    let notificationService: { emit: jest.Mock };
    let rateLimiter: { shouldEmit: jest.Mock };
    let prAuthorResolver: { resolve: jest.Mock };
    let usersService: { find: jest.Mock };
    let parametersService: { findByKey: jest.Mock };
    let organizationParametersService: { findByKey: jest.Mock };
    let permissionValidationService: { validateExecutionPermissions: jest.Mock };
    let autoAssignLicenseUseCase: { execute: jest.Mock };

    // Frozen by DEFAULT — production hands every stage after the first
    // produce() a deep-frozen context. See test/fixtures/frozen-pipeline-context.ts.
    const makeContext = (
        over: Record<string, unknown> = {},
    ): CodeReviewPipelineContext =>
        frozenContext({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            } as any,
            repository: { id: 'repo-1', name: 'acme/api' } as any,
            pullRequest: {
                number: 42,
                state: 'open',
                locked: false,
                url: 'https://github.com/acme/api/pull/42',
                user: { email: 'alex@acme.com', username: 'alex' },
            } as any,
            userGitId: 'gh-99',
            platformType: PlatformType.GITHUB,
            branch: 'feature/test',
            teamAutomationId: 'automation-1',
            origin: 'opened',
            action: 'opened',
            dryRun: { enabled: false },
            errors: [],
            preparedFileContexts: [],
            validSuggestions: [],
            discardedSuggestions: [],
            validSuggestionsByPR: [],
            validCrossFileSuggestions: [],
            pipelineMetadata: {},
            statusInfo: { status: 'in_progress' as any, message: 'started' },
            pipelineVersion: '1.0.0',
            ...over,
        }) as CodeReviewPipelineContext;

    beforeEach(async () => {
        notificationService = { emit: jest.fn().mockResolvedValue(undefined) };
        rateLimiter = { shouldEmit: jest.fn().mockResolvedValue(true) };
        prAuthorResolver = { resolve: jest.fn() };
        usersService = { find: jest.fn().mockResolvedValue([]) };
        parametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: {
                    configs: { showStatusFeedback: true },
                    repositories: [],
                },
            }),
        };
        organizationParametersService = {
            findByKey: jest.fn().mockResolvedValue(undefined),
        };
        permissionValidationService = {
            validateExecutionPermissions: jest.fn().mockResolvedValue({
                allowed: false,
                errorType: ValidationErrorType.USER_NOT_LICENSED,
            }),
        };
        autoAssignLicenseUseCase = {
            execute: jest.fn().mockResolvedValue({
                shouldProceed: false,
                reason: 'NOT_ENOUGH_PRS',
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ValidatePrerequisitesStage,
                {
                    provide: PermissionValidationService,
                    useValue: permissionValidationService,
                },
                {
                    provide: AutoAssignLicenseUseCase,
                    useValue: autoAssignLicenseUseCase,
                },
                {
                    provide: ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
                    useValue: organizationParametersService,
                },
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: parametersService,
                },
                {
                    provide: PULL_REQUESTS_SERVICE_TOKEN,
                    useValue: { find: jest.fn().mockResolvedValue([]) },
                },
                {
                    provide: CodeManagementService,
                    useValue: {
                        addReactionToPR: jest.fn().mockResolvedValue(undefined),
                        addReactionToComment: jest.fn().mockResolvedValue(undefined),
                        createIssueComment: jest.fn().mockResolvedValue(undefined),
                        createResponseToComment: jest.fn().mockResolvedValue(undefined),
                    },
                },
                { provide: NotificationService, useValue: notificationService },
                { provide: NotificationRateLimiter, useValue: rateLimiter },
                {
                    provide: PrAuthorRecipientResolver,
                    useValue: prAuthorResolver,
                },
                { provide: USER_SERVICE_TOKEN, useValue: usersService },
                {
                    provide: LICENSE_SERVICE_TOKEN,
                    useValue: {
                        startTrial: jest.fn().mockResolvedValue(false),
                    },
                },
            ],
        }).compile();

        stage = module.get(ValidatePrerequisitesStage);
    });

    it('emits review.skipped_no_license when license fails AND author is a registered user', async () => {
        prAuthorResolver.resolve.mockResolvedValueOnce({
            kind: 'user',
            userId: 'user-1',
        });
        usersService.find.mockResolvedValueOnce([
            { email: 'owner@acme.com' } as any,
        ]);

        const result = await stage.execute(makeContext());

        expect(result.statusInfo?.status).toBe(AutomationStatus.SKIPPED);
        expect(notificationService.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                event: NotificationEvent.REVIEW_SKIPPED_NO_LICENSE,
                organizationId: 'org-1',
                recipients: { kind: 'user', userId: 'user-1' },
                payload: expect.objectContaining({
                    prUrl: 'https://github.com/acme/api/pull/42',
                    repoName: 'acme/api',
                    ownerContact: 'owner@acme.com',
                    authorUsername: 'alex',
                }),
            }),
        );
    });

    // The author handle mirrors the precedence used to persist `user.username`
    // in the pullRequests collection (PullRequestsService.extractUser):
    // login -> username -> nickname -> uniqueName -> descriptor.
    it.each([
        // GitHub: raw payload exposes only `login` (the @username).
        [{ login: 'octocat' }, 'octocat'],
        // GitLab / Bitbucket DC: username handle.
        [{ username: 'ada' }, 'ada'],
        // Bitbucket Cloud: no login/username, only the nickname.
        [{ nickname: 'ada-lovelace' }, 'ada-lovelace'],
        // Azure: identified by the UPN in `uniqueName` (email-format).
        [{ uniqueName: 'ada@contoso.com' }, 'ada@contoso.com'],
    ])(
        'resolves the author handle like the pullRequests collection (%o)',
        async (user, expected) => {
            prAuthorResolver.resolve.mockResolvedValueOnce({
                kind: 'user',
                userId: 'user-1',
            });
            usersService.find.mockResolvedValueOnce([
                { email: 'owner@acme.com' } as any,
            ]);

            // Built frozen, so the author shape is an override, not a
            // post-hoc mutation.
            const context = makeContext({
                pullRequest: { number: 42, state: 'open', locked: false, user },
            });

            await stage.execute(context);

            expect(notificationService.emit).toHaveBeenCalledWith(
                expect.objectContaining({
                    payload: expect.objectContaining({
                        authorUsername: expected,
                    }),
                }),
            );
        },
    );

    it('skips the emit when the rate limiter rejects (already notified within 24h)', async () => {
        prAuthorResolver.resolve.mockResolvedValueOnce({
            kind: 'user',
            userId: 'user-1',
        });
        rateLimiter.shouldEmit.mockResolvedValueOnce(false);

        await stage.execute(makeContext());

        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('falls back to org owners when the PR author is a bot/external user (resolver returns null)', async () => {
        prAuthorResolver.resolve.mockResolvedValueOnce(null);
        usersService.find.mockResolvedValueOnce([
            { email: 'owner@acme.com' } as any,
        ]);

        await stage.execute(makeContext());

        // Rate-limited under a shared "owners" bucket, then emitted to OWNER.
        expect(rateLimiter.shouldEmit).toHaveBeenCalledWith(
            expect.stringContaining(':owners:'),
            expect.any(Number),
        );
        expect(notificationService.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                event: NotificationEvent.REVIEW_SKIPPED_NO_LICENSE,
                recipients: expect.objectContaining({
                    kind: 'role',
                    role: 'owner',
                }),
            }),
        );
    });

    it('omits ownerContact when no owner is registered for the org', async () => {
        prAuthorResolver.resolve.mockResolvedValueOnce({
            kind: 'user',
            userId: 'user-1',
        });
        usersService.find.mockResolvedValueOnce([]); // no owners

        await stage.execute(makeContext());

        expect(notificationService.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                payload: expect.objectContaining({ ownerContact: undefined }),
            }),
        );
    });

    it('uses a per-(user,org) rate-limit key so different users do not collide', async () => {
        prAuthorResolver.resolve.mockResolvedValueOnce({
            kind: 'user',
            userId: 'user-1',
        });

        await stage.execute(makeContext());

        expect(rateLimiter.shouldEmit).toHaveBeenCalledWith(
            expect.stringContaining('user-1'),
            expect.any(Number),
        );
        expect(rateLimiter.shouldEmit).toHaveBeenCalledWith(
            expect.stringContaining('org-1'),
            expect.any(Number),
        );
    });
});
