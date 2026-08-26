import { RunCodeReviewAutomationUseCase } from './runCodeReview.use-case';
import { PrReviewInProgressError } from '@libs/code-review/domain/errors/pr-review-in-progress.error';
import { PlatformType } from '@libs/core/domain/enums';

const TARGET = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: 'repo-1', name: 'repo-name' },
    pullRequest: { number: 42 },
    platformType: PlatformType.GITHUB,
    triggerCommentId: 7,
};

const makeParams = (): any => ({
    codeManagementPayload: {
        origin: 'command',
        action: 'synchronize',
        repository: { id: 'repo-1', name: 'repo-name', full_name: 'o/repo' },
        issue: { number: 42 },
        pull_request: {
            number: 42,
            head: { ref: 'feature', sha: 'sha-1', repo: {} },
            base: { ref: 'main', sha: 'sha-0', repo: {} },
            user: { id: '1', login: 'someone' },
        },
        sender: { id: '1' },
    },
    event: 'issue_comment',
    platformType: PlatformType.GITHUB,
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    teamAutomationId: 'team-automation-1',
    correlationId: 'corr-1',
});

describe('RunCodeReviewAutomationUseCase', () => {
    let useCase: RunCodeReviewAutomationUseCase;
    let executeAutomation: { executeStrategy: jest.Mock };
    let codeManagementService: Record<string, jest.Mock>;

    beforeEach(() => {
        executeAutomation = { executeStrategy: jest.fn() };
        codeManagementService = {
            getPullRequest: jest.fn().mockResolvedValue(null),
            getLanguageRepository: jest.fn().mockResolvedValue('TypeScript'),
            resolveMrAuthorFromWebhookPayload: jest.fn(),
        };

        useCase = new RunCodeReviewAutomationUseCase(
            executeAutomation as any,
            codeManagementService as any,
        );
    });

    // The catch-all here exists so a broken review cannot take the worker
    // down. It also used to absorb the "PR is busy" signal, which left the
    // job processor with nothing to reschedule (#1700).
    it('lets a refused review command through to the caller', async () => {
        executeAutomation.executeStrategy.mockRejectedValue(
            new PrReviewInProgressError({ gate: 'lock', target: TARGET }),
        );

        await expect(useCase.execute(makeParams())).rejects.toBeInstanceOf(
            PrReviewInProgressError,
        );
    });

    it('still absorbs every other failure', async () => {
        executeAutomation.executeStrategy.mockRejectedValue(
            new Error('pipeline exploded'),
        );

        await expect(useCase.execute(makeParams())).resolves.toBeUndefined();
    });
});
