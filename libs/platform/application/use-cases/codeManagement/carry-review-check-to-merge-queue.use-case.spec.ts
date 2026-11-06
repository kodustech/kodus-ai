import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { KODY_CHECK_RUN_NAME } from '@libs/core/infrastructure/pipeline/services/pipeline-checks.service';
import { WebhookContextService } from '@libs/platform/application/services/webhook-context.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { GithubChecksService } from '@libs/platform/infrastructure/adapters/services/github/github-checks.service';
import { Test, TestingModule } from '@nestjs/testing';
import { CarryReviewCheckToMergeQueueUseCase } from './carry-review-check-to-merge-queue.use-case';

describe('CarryReviewCheckToMergeQueueUseCase', () => {
    let useCase: CarryReviewCheckToMergeQueueUseCase;
    let webhookContextService: { getContext: jest.Mock };
    let codeManagement: { getPullRequest: jest.Mock };
    let checks: {
        findLatestCompletedCheckRun: jest.Mock;
        createCompletedCheckRun: jest.Mock;
        findMergeQueueEntryHeadSha: jest.Mock;
    };

    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const baseSha = 'b849a34be3d6e2b91399a6ddca1a4d3ea153839d';
    const queueSha = '8abdf355fd81b893471909152d4c95964c449407';
    const headSha = '60c06c3da6bbe7dc34f94201a5361aa050b670e7';

    const queuePush = (overrides: Record<string, unknown> = {}) => ({
        platformType: PlatformType.GITHUB,
        event: 'push',
        payload: {
            ref: `refs/heads/gh-readonly-queue/main/pr-7-${baseSha}`,
            after: queueSha,
            created: true,
            deleted: false,
            repository: {
                id: 999,
                name: 'service',
                full_name: 'acme/service',
            },
            ...overrides,
        },
    });

    beforeEach(async () => {
        webhookContextService = {
            getContext: jest.fn().mockResolvedValue({
                organizationAndTeamData,
                teamAutomationId: 'ta-1',
            }),
        };
        codeManagement = {
            getPullRequest: jest
                .fn()
                .mockResolvedValue({ number: 7, head: { sha: headSha } }),
        };
        checks = {
            findLatestCompletedCheckRun: jest.fn().mockResolvedValue({
                id: 2,
                conclusion: 'success',
                title: 'Code Review Complete',
                htmlUrl: 'https://github.com/acme/service/runs/2',
            }),
            createCompletedCheckRun: jest.fn().mockResolvedValue(77),
            findMergeQueueEntryHeadSha: jest.fn().mockResolvedValue(queueSha),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CarryReviewCheckToMergeQueueUseCase,
                {
                    provide: WebhookContextService,
                    useValue: webhookContextService,
                },
                { provide: CodeManagementService, useValue: codeManagement },
                { provide: GithubChecksService, useValue: checks },
            ],
        }).compile();

        useCase = module.get(CarryReviewCheckToMergeQueueUseCase);
    });

    it("posts the PR head's finished Kody result on the merge queue commit", async () => {
        await expect(useCase.execute(queuePush())).resolves.toEqual({
            carried: true,
            conclusion: 'success',
        });

        expect(webhookContextService.getContext).toHaveBeenCalledWith(
            PlatformType.GITHUB,
            '999',
        );
        expect(codeManagement.getPullRequest).toHaveBeenCalledWith(
            {
                organizationAndTeamData,
                repository: { id: '999', name: 'service' },
                prNumber: 7,
            },
            PlatformType.GITHUB,
        );
        expect(checks.findLatestCompletedCheckRun).toHaveBeenCalledWith({
            organizationAndTeamData,
            repository: { owner: 'acme', name: 'service' },
            headSha,
            name: KODY_CHECK_RUN_NAME,
        });
        expect(checks.createCompletedCheckRun).toHaveBeenCalledWith({
            organizationAndTeamData,
            repository: { owner: 'acme', name: 'service' },
            headSha: queueSha,
            name: KODY_CHECK_RUN_NAME,
            conclusion: 'success',
            detailsUrl: 'https://github.com/acme/service/runs/2',
            output: {
                title: 'Code Review Complete',
                summary: expect.stringContaining('PR #7'),
            },
        });
    });

    it("asks GitHub's merge queue which commit it built for the PR", async () => {
        await useCase.execute(queuePush());

        expect(checks.findMergeQueueEntryHeadSha).toHaveBeenCalledWith({
            organizationAndTeamData,
            repository: { owner: 'acme', name: 'service' },
            prNumber: 7,
        });
    });

    it.each([
        ['the PR is not in the merge queue', null],
        ['the queue built a different commit for the PR', 'f'.repeat(40)],
    ])(
        'posts nothing when %s, so a branch named like a queue branch gets no check',
        async (_label, entrySha) => {
            checks.findMergeQueueEntryHeadSha.mockResolvedValue(entrySha);

            await expect(useCase.execute(queuePush())).resolves.toEqual({
                carried: false,
                reason: 'not_in_merge_queue',
            });
            expect(checks.findLatestCompletedCheckRun).not.toHaveBeenCalled();
            expect(checks.createCompletedCheckRun).not.toHaveBeenCalled();
        },
    );

    it('rethrows a GitHub rate limit so the webhook job is retried after the reset', async () => {
        checks.createCompletedCheckRun.mockRejectedValue(
            Object.assign(new Error('API rate limit exceeded'), {
                status: 403,
                response: {
                    headers: {
                        'x-ratelimit-remaining': '0',
                        'x-ratelimit-reset': String(
                            Math.floor(Date.now() / 1000) + 600,
                        ),
                    },
                },
            }),
        );

        await expect(useCase.execute(queuePush())).rejects.toThrow(
            'API rate limit exceeded',
        );
    });

    it.each(['failure', 'neutral', 'skipped'])(
        'carries a %s conclusion unchanged',
        async (conclusion) => {
            checks.findLatestCompletedCheckRun.mockResolvedValue({
                id: 2,
                conclusion,
                title: 't',
            });

            await useCase.execute(queuePush());

            expect(checks.createCompletedCheckRun).toHaveBeenCalledWith(
                expect.objectContaining({ conclusion }),
            );
        },
    );

    it('posts nothing when the PR head has no finished Kody run', async () => {
        checks.findLatestCompletedCheckRun.mockResolvedValue(null);

        await expect(useCase.execute(queuePush())).resolves.toEqual({
            carried: false,
            reason: 'no_completed_run',
        });
        expect(checks.createCompletedCheckRun).not.toHaveBeenCalled();
    });

    it('posts nothing when the repository is not set up in Kodus', async () => {
        webhookContextService.getContext.mockResolvedValue(null);

        await expect(useCase.execute(queuePush())).resolves.toEqual({
            carried: false,
            reason: 'no_context',
        });
        expect(codeManagement.getPullRequest).not.toHaveBeenCalled();
        expect(checks.createCompletedCheckRun).not.toHaveBeenCalled();
    });

    it('posts nothing when the PR cannot be read', async () => {
        codeManagement.getPullRequest.mockResolvedValue(null);

        await expect(useCase.execute(queuePush())).resolves.toEqual({
            carried: false,
            reason: 'pr_lookup_failed',
        });
        expect(checks.createCompletedCheckRun).not.toHaveBeenCalled();
    });

    it('logs and swallows GitHub errors instead of failing the webhook job', async () => {
        checks.createCompletedCheckRun.mockRejectedValue(new Error('boom'));

        await expect(useCase.execute(queuePush())).resolves.toEqual({
            carried: false,
            reason: 'api_error',
        });
    });

    it.each([
        ['an ordinary branch push', { ref: 'refs/heads/main' }],
        [
            'the queue branch being deleted',
            { deleted: true, after: '0'.repeat(40) },
        ],
    ])('ignores %s', async (_label, overrides) => {
        await expect(useCase.execute(queuePush(overrides))).resolves.toEqual({
            carried: false,
            reason: 'not_merge_queue_push',
        });
        expect(webhookContextService.getContext).not.toHaveBeenCalled();
    });
});
