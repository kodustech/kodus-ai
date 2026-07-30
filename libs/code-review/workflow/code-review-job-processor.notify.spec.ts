import { NotificationService } from '@libs/notifications/application/notification.service';
import { PrAuthorRecipientResolver } from '@libs/notifications/application/pr-author-recipient.resolver';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

import { CodeReviewJobProcessorService } from './code-review-job-processor.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

/**
 * Tests focus on the private notifyReviewFailed helper. The
 * surrounding process()/handleFailure logic has its own coverage; this
 * file only exercises the platform-payload extraction + recipient
 * composition that's specific to review.failed.
 */
describe('CodeReviewJobProcessorService — review.failed emit', () => {
    let notificationService: jest.Mocked<Pick<NotificationService, 'emit'>>;
    let prAuthorResolver: jest.Mocked<
        Pick<PrAuthorRecipientResolver, 'resolve'>
    >;
    let processor: CodeReviewJobProcessorService;

    beforeEach(() => {
        notificationService = { emit: jest.fn().mockResolvedValue(undefined) };
        prAuthorResolver = { resolve: jest.fn().mockResolvedValue(null) };
        processor = new CodeReviewJobProcessorService(
            // jobRepository — not used by notifyReviewFailed
            { update: jest.fn(), findOne: jest.fn() } as any,
            // runCodeReviewAutomationUseCase — not used
            { execute: jest.fn() } as any,
            // byokConcurrencyGateService — not used
            { tryEnter: jest.fn(), deferJob: jest.fn() } as any,
            notificationService as unknown as NotificationService,
            prAuthorResolver as unknown as PrAuthorRecipientResolver,
            // rateLimitGate — not used by notifyReviewFailed
            { check: jest.fn().mockResolvedValue(undefined) } as any,
        );
    });

    const callNotify = (
        payload: unknown,
        error: Error = new Error('terminal failure'),
        correlationId = 'corr-1',
    ) =>
        (processor as any).notifyReviewFailed(
            { payload },
            error,
            correlationId,
        );

    it('emits with the PR author as the only directed recipient (owners are the config audience)', async () => {
        prAuthorResolver.resolve.mockResolvedValueOnce({
            kind: 'user',
            userId: 'user-1',
        });

        await callNotify({
            organizationAndTeamData: { organizationId: 'org-1' },
            codeManagementPayload: {
                pull_request: {
                    html_url: 'https://github.com/acme/api/pull/1',
                    user: { email: 'alex@a.com', login: 'alex' },
                },
                repository: { full_name: 'acme/api' },
            },
        });

        expect(notificationService.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                event: NotificationEvent.REVIEW_FAILED,
                organizationId: 'org-1',
                correlationId: 'corr-1',
                // Owners are no longer hardcoded — they come from the catalog's
                // defaultRoles; only the PR author is a directed recipient.
                recipients: [{ kind: 'user', userId: 'user-1' }],
                payload: expect.objectContaining({
                    prUrl: 'https://github.com/acme/api/pull/1',
                    repoName: 'acme/api',
                    reason: 'terminal failure',
                    correlationId: 'corr-1',
                }),
            }),
        );
    });

    it('emits with no directed recipients when the PR author cannot be resolved (owners via audience)', async () => {
        prAuthorResolver.resolve.mockResolvedValueOnce(null);

        await callNotify({
            organizationAndTeamData: { organizationId: 'org-1' },
            codeManagementPayload: {
                pull_request: {
                    html_url: 'https://github.com/acme/api/pull/1',
                    user: { email: 'dependabot@github.com', login: 'dependabot[bot]' },
                },
                repository: { full_name: 'acme/api' },
            },
        });

        const emitArgs = notificationService.emit.mock.calls[0][0];
        expect(emitArgs.recipients).toEqual([]);
    });

    it('skips when organizationId is missing from the job payload', async () => {
        await callNotify({});
        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('extracts GitLab merge_request shape', async () => {
        prAuthorResolver.resolve.mockResolvedValueOnce(null);

        await callNotify({
            organizationAndTeamData: { organizationId: 'org-1' },
            codeManagementPayload: {
                object_attributes: {
                    web_url: 'https://gitlab.com/acme/api/-/merge_requests/3',
                },
                repository: { name: 'acme/api' },
            },
        });

        expect(notificationService.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                payload: expect.objectContaining({
                    prUrl: 'https://gitlab.com/acme/api/-/merge_requests/3',
                    repoName: 'acme/api',
                }),
            }),
        );
    });

    it('extracts Bitbucket pullrequest shape', async () => {
        prAuthorResolver.resolve.mockResolvedValueOnce(null);

        await callNotify({
            organizationAndTeamData: { organizationId: 'org-1' },
            codeManagementPayload: {
                pullrequest: { url: 'https://bitbucket.org/acme/api/pull-requests/9' },
                repository: { full_name: 'acme/api' },
            },
        });

        expect(notificationService.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                payload: expect.objectContaining({
                    prUrl: 'https://bitbucket.org/acme/api/pull-requests/9',
                }),
            }),
        );
    });

    it('falls back to empty strings when payload fields are absent (still notifies owners)', async () => {
        prAuthorResolver.resolve.mockResolvedValueOnce(null);

        await callNotify({
            organizationAndTeamData: { organizationId: 'org-1' },
            codeManagementPayload: {},
        });

        expect(notificationService.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                payload: expect.objectContaining({
                    prUrl: '',
                    repoName: '',
                    reason: 'terminal failure',
                }),
            }),
        );
    });

    it('does not throw when notificationService.emit itself fails', async () => {
        prAuthorResolver.resolve.mockResolvedValueOnce(null);
        notificationService.emit.mockRejectedValueOnce(new Error('outbox down'));

        await expect(
            callNotify({
                organizationAndTeamData: { organizationId: 'org-1' },
                codeManagementPayload: {},
            }),
        ).resolves.not.toThrow();
    });
});
