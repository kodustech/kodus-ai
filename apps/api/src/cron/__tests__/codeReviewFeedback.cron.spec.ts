import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';

import { CodeReviewFeedbackCronProvider } from '../codeReviewFeedback.cron';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('CodeReviewFeedbackCronProvider', () => {
    const makeCron = (
        executions: Array<{
            repositoryId?: string;
            dataExecution?: { pullRequestNumber?: number | null };
        }>,
    ) => {
        const automationExecutionService = {
            findByPeriodAndTeamAutomationId: jest
                .fn()
                .mockResolvedValue(executions),
        } as any;

        const messageBroker = {
            transformMessageToMessageBroker: jest
                .fn()
                .mockImplementation((m) => m),
            publishMessage: jest.fn().mockResolvedValue(undefined),
        } as any;

        const teamService = {
            findTeamsWithIntegrations: jest.fn().mockResolvedValue([
                {
                    uuid: 'team-1',
                    organization: { uuid: 'org-1' },
                    isCodeManagementConfigured: true,
                },
            ]),
        } as any;

        const automationService = {
            find: jest.fn().mockResolvedValue([{ uuid: 'automation-1' }]),
        } as any;

        const teamAutomationService = {
            find: jest.fn().mockResolvedValue([{ uuid: 'team-automation-1' }]),
        } as any;

        const distributedLockService = {
            acquire: jest.fn().mockResolvedValue({
                release: jest.fn().mockResolvedValue(undefined),
            }),
        } as any;

        const cron = new CodeReviewFeedbackCronProvider(
            messageBroker,
            teamService,
            automationExecutionService,
            automationService,
            teamAutomationService,
            distributedLockService,
        );

        return { cron, automationExecutionService, messageBroker };
    };

    /**
     * A review that delivered its comments and then failed at a later step
     * lands on PARTIAL_ERROR. Its comments are on the PR and can be reacted to
     * like any other, but while the cron asked for SUCCESS alone those PRs were
     * invisible to the sync — permanently, since nothing ever revisits them.
     */
    it('asks for both success and partial_error executions', async () => {
        const { cron, automationExecutionService } = makeCron([
            { dataExecution: { pullRequestNumber: 42 } },
        ]);

        await cron.handleCron();

        const statuses =
            automationExecutionService.findByPeriodAndTeamAutomationId.mock
                .calls[0][3];

        expect(statuses).toEqual(
            expect.arrayContaining([
                AutomationStatus.SUCCESS,
                AutomationStatus.PARTIAL_ERROR,
            ]),
        );
    });

    it('does not ask for states that never delivered a comment', async () => {
        const { cron, automationExecutionService } = makeCron([
            { dataExecution: { pullRequestNumber: 42 } },
        ]);

        await cron.handleCron();

        const statuses =
            automationExecutionService.findByPeriodAndTeamAutomationId.mock
                .calls[0][3];

        expect(statuses).not.toContain(AutomationStatus.SKIPPED);
        expect(statuses).not.toContain(AutomationStatus.ERROR);
        expect(statuses).not.toContain(AutomationStatus.IN_PROGRESS);
        expect(statuses).not.toContain(AutomationStatus.PENDING);
    });

    it('publishes the PR numbers it collected', async () => {
        const { cron, messageBroker } = makeCron([
            { dataExecution: { pullRequestNumber: 42 } },
            { dataExecution: { pullRequestNumber: 43 } },
        ]);

        await cron.handleCron();

        expect(
            messageBroker.transformMessageToMessageBroker,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.objectContaining({
                    automationExecutionsPRs: [42, 43],
                }),
            }),
        );
    });

    const published = (messageBroker: any) =>
        messageBroker.transformMessageToMessageBroker.mock.calls[0][0].message;

    it('publishes each PR once, however many pushes it was reviewed on', async () => {
        const { cron, messageBroker } = makeCron([
            {
                repositoryId: 'repo-a',
                dataExecution: { pullRequestNumber: 42 },
            },
            {
                repositoryId: 'repo-a',
                dataExecution: { pullRequestNumber: 42 },
            },
            {
                repositoryId: 'repo-a',
                dataExecution: { pullRequestNumber: 43 },
            },
            // An execution with no PR number names no PR.
            {
                repositoryId: 'repo-a',
                dataExecution: { pullRequestNumber: null },
            },
            { repositoryId: 'repo-a', dataExecution: {} },
            { repositoryId: 'repo-a' },
            null as any,
        ]);

        await cron.handleCron();

        expect(published(messageBroker).automationExecutionsPRs).toStrictEqual([
            42, 43,
        ]);
    });

    it('narrows the lookup to the repositories when every execution names its own', async () => {
        const { cron, messageBroker } = makeCron([
            { repositoryId: 'repo-a', dataExecution: { pullRequestNumber: 1 } },
            { repositoryId: 'repo-b', dataExecution: { pullRequestNumber: 2 } },
            { repositoryId: 'repo-a', dataExecution: { pullRequestNumber: 3 } },
        ]);

        await cron.handleCron();

        expect(published(messageBroker).repositoryIds).toEqual([
            'repo-a',
            'repo-b',
        ]);
    });

    it('sends no repositories when one execution lacks its own, so its PR is not left out', async () => {
        const { cron, messageBroker } = makeCron([
            { repositoryId: 'repo-a', dataExecution: { pullRequestNumber: 1 } },
            { dataExecution: { pullRequestNumber: 2 } },
        ]);

        await cron.handleCron();

        expect(published(messageBroker)).not.toHaveProperty('repositoryIds');
        expect(published(messageBroker).automationExecutionsPRs).toEqual([
            1, 2,
        ]);
    });

    it('publishes nothing for a team whose executions name no PR', async () => {
        const { cron, messageBroker } = makeCron([
            { repositoryId: 'repo-a', dataExecution: {} },
            {
                repositoryId: 'repo-a',
                dataExecution: { pullRequestNumber: null },
            },
        ]);

        await cron.handleCron();

        expect(messageBroker.publishMessage).not.toHaveBeenCalled();
    });
});
