import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { CodeReviewHandlerService } from '@libs/code-review/infrastructure/adapters/services/codeReviewHandlerService.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('CodeReviewHandlerService - skip feedback control', () => {
    const mockPipelineExecute = jest.fn();
    const mockPipelineFactory = {
        getPipeline: jest.fn(() => ({
            execute: mockPipelineExecute,
        })),
    };

    const mockCodeManagement = {
        createIssueComment: jest.fn(),
        createResponseToComment: jest.fn(),
        addReactionToComment: jest.fn(),
        addReactionToPR: jest.fn(),
        removeReactionsFromComment: jest.fn(),
        removeReactionsFromPR: jest.fn(),
    };

    const service = new CodeReviewHandlerService(
        mockPipelineFactory as any,
        mockCodeManagement as any,
        {
            findByKey: jest.fn(),
            createOrUpdateConfig: jest.fn(),
        } as any,
        { firstReviewCompleted: jest.fn() } as any,
    );

    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const repository = {
        id: 'repo-1',
        name: 'repo-name',
    };

    const pullRequest = {
        number: 42,
    };

    const createSkippedPipelineResult = (overrides: Record<string, any> = {}) =>
        ({
            statusInfo: {
                status: AutomationStatus.SKIPPED,
                message: 'Automated Review is disabled',
            },
            platformType: PlatformType.BITBUCKET,
            organizationAndTeamData,
            repository,
            pullRequest,
            codeReviewConfig: {
                automatedReviewActive: true,
                showStatusFeedback: true,
            },
            pipelineMetadata: {},
            ...overrides,
        }) as any;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('does not send skip emoji when automated review is disabled', async () => {
        mockPipelineExecute.mockResolvedValue(
            createSkippedPipelineResult({
                codeReviewConfig: {
                    automatedReviewActive: false,
                    showStatusFeedback: true,
                },
            }),
        );

        await service.handlePullRequest(
            organizationAndTeamData as any,
            repository as any,
            'main',
            pullRequest as any,
            PlatformType.BITBUCKET,
            'team-automation-id',
            'webhook',
            'opened',
            'execution-id',
        );

        expect(mockCodeManagement.createIssueComment).not.toHaveBeenCalled();
        expect(
            mockCodeManagement.createResponseToComment,
        ).not.toHaveBeenCalled();
    });

    it('does not send skip emoji when show feedback config is disabled', async () => {
        mockPipelineExecute.mockResolvedValue(
            createSkippedPipelineResult({
                codeReviewConfig: {
                    automatedReviewActive: true,
                    showStatusFeedback: false,
                },
            }),
        );

        await service.handlePullRequest(
            organizationAndTeamData as any,
            repository as any,
            'main',
            pullRequest as any,
            PlatformType.BITBUCKET,
            'team-automation-id',
            'webhook',
            'opened',
            'execution-id',
        );

        expect(mockCodeManagement.createIssueComment).not.toHaveBeenCalled();
        expect(
            mockCodeManagement.createResponseToComment,
        ).not.toHaveBeenCalled();
    });

    it('sends skip emoji when show feedback is enabled and automated review is enabled', async () => {
        mockPipelineExecute.mockResolvedValue(
            createSkippedPipelineResult({
                codeReviewConfig: {
                    automatedReviewActive: true,
                    showStatusFeedback: true,
                },
            }),
        );

        await service.handlePullRequest(
            organizationAndTeamData as any,
            repository as any,
            'main',
            pullRequest as any,
            PlatformType.BITBUCKET,
            'team-automation-id',
            'webhook',
            'opened',
            'execution-id',
        );

        expect(mockCodeManagement.createIssueComment).toHaveBeenCalledTimes(1);
        expect(mockCodeManagement.createIssueComment).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData,
                repository,
                prNumber: pullRequest.number,
                body: expect.stringContaining('what-each-emoji-means'),
            }),
        );
    });

    it('removes current reaction when notification is already handled', async () => {
        mockPipelineExecute.mockResolvedValue(
            createSkippedPipelineResult({
                platformType: PlatformType.GITHUB,
                pipelineMetadata: {
                    notificationHandled: true,
                },
            }),
        );

        await service.handlePullRequest(
            organizationAndTeamData as any,
            repository as any,
            'main',
            pullRequest as any,
            PlatformType.GITHUB,
            'team-automation-id',
            'webhook',
            'opened',
            'execution-id',
        );

        expect(mockCodeManagement.removeReactionsFromPR).toHaveBeenCalledTimes(
            1,
        );
        expect(mockCodeManagement.addReactionToPR).toHaveBeenCalledTimes(1);
    });

    it('suppresses skip feedback when metadata flag is disabled even without codeReviewConfig', async () => {
        mockPipelineExecute.mockResolvedValue(
            createSkippedPipelineResult({
                platformType: PlatformType.GITHUB,
                codeReviewConfig: undefined,
                pipelineMetadata: {
                    showStatusFeedback: false,
                },
            }),
        );

        await service.handlePullRequest(
            organizationAndTeamData as any,
            repository as any,
            'main',
            pullRequest as any,
            PlatformType.GITHUB,
            'team-automation-id',
            'webhook',
            'opened',
            'execution-id',
        );

        expect(mockCodeManagement.removeReactionsFromPR).toHaveBeenCalledTimes(
            1,
        );
        expect(mockCodeManagement.addReactionToPR).toHaveBeenCalledTimes(1);
    });
});
