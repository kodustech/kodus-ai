import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { AutomationExecutionService } from '@libs/automation/infrastructure/adapters/services/automationExecution.service';

describe('AutomationExecutionService', () => {
    const makeService = () => {
        const automationExecutionRepository = {
            findByPeriodAndTeamAutomationId: jest.fn(),
            findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId:
                jest.fn(),
            find: jest.fn(),
        } as any;
        const codeReviewExecutionService = {
            existsByAutomationExecutionAndStageStatus: jest.fn(),
            findManyByAutomationExecutionIds: jest.fn(),
        } as any;
        const cacheService = {} as any;
        const eventEmitter = { emit: jest.fn() } as any;

        const service = new AutomationExecutionService(
            automationExecutionRepository,
            codeReviewExecutionService,
            cacheService,
            eventEmitter,
        );

        return {
            service,
            codeReviewExecutionService,
            automationExecutionRepository,
        };
    };

    it('should return false when required filters are missing', async () => {
        const { service, codeReviewExecutionService } = makeService();

        await expect(
            service.hasStageWithStatus(
                '',
                ['FileAnalysisStage'],
                [AutomationStatus.PARTIAL_ERROR],
            ),
        ).resolves.toBe(false);
        await expect(
            service.hasStageWithStatus(
                'exec-1',
                [],
                [AutomationStatus.PARTIAL_ERROR],
            ),
        ).resolves.toBe(false);
        await expect(
            service.hasStageWithStatus('exec-1', ['FileAnalysisStage'], []),
        ).resolves.toBe(false);

        expect(
            codeReviewExecutionService.existsByAutomationExecutionAndStageStatus,
        ).not.toHaveBeenCalled();
    });

    it('should delegate to exists query for stage status checks', async () => {
        const { service, codeReviewExecutionService } = makeService();
        codeReviewExecutionService.existsByAutomationExecutionAndStageStatus.mockResolvedValue(
            true,
        );

        await expect(
            service.hasStageWithStatus(
                'exec-1',
                ['PRLevelReviewStage', 'FileAnalysisStage'],
                [AutomationStatus.PARTIAL_ERROR, AutomationStatus.ERROR],
            ),
        ).resolves.toBe(true);

        expect(
            codeReviewExecutionService.existsByAutomationExecutionAndStageStatus,
        ).toHaveBeenCalledWith(
            'exec-1',
            ['PRLevelReviewStage', 'FileAnalysisStage'],
            [AutomationStatus.PARTIAL_ERROR, AutomationStatus.ERROR],
        );
        expect(
            codeReviewExecutionService.findManyByAutomationExecutionIds,
        ).not.toHaveBeenCalled();
    });

    it('should delegate period query with array status to repository', async () => {
        const { service, automationExecutionRepository } = makeService();
        const startDate = new Date('2026-03-01T00:00:00.000Z');
        const endDate = new Date('2026-03-08T00:00:00.000Z');
        const teamAutomationId = 'team-automation-1';
        const statuses = [
            AutomationStatus.SUCCESS,
            AutomationStatus.IN_PROGRESS,
        ];

        automationExecutionRepository.findByPeriodAndTeamAutomationId.mockResolvedValue(
            [{ uuid: 'exec-1' }],
        );

        const result = await service.findByPeriodAndTeamAutomationId(
            startDate,
            endDate,
            teamAutomationId,
            statuses,
        );

        expect(
            automationExecutionRepository.findByPeriodAndTeamAutomationId,
        ).toHaveBeenCalledWith(startDate, endDate, teamAutomationId, statuses);
        expect(result).toEqual([{ uuid: 'exec-1' }]);
    });

    it('should delegate find with compound filters used by final approval check', async () => {
        const { service, automationExecutionRepository } = makeService();

        automationExecutionRepository.find.mockResolvedValue([
            { uuid: 'exec-2' },
        ]);

        const filter = {
            teamAutomation: { uuid: 'team-automation-1' },
            pullRequestNumber: 123,
            repositoryId: 'repo-1',
            status: AutomationStatus.IN_PROGRESS,
        };

        const result = await service.find(filter as any);

        expect(automationExecutionRepository.find).toHaveBeenCalledWith(filter);
        expect(result).toEqual([{ uuid: 'exec-2' }]);
    });

    it('should delegate eligible pull request refs query for approval cron', async () => {
        const { service, automationExecutionRepository } = makeService();
        const startDate = new Date('2026-03-01T00:00:00.000Z');
        const endDate = new Date('2026-03-08T00:00:00.000Z');
        const teamAutomationId = 'team-automation-1';

        automationExecutionRepository.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId.mockResolvedValue(
            [{ repositoryId: 'repo-1', pullRequestNumber: 101 }],
        );

        const result =
            await service.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId(
                startDate,
                endDate,
                teamAutomationId,
            );

        expect(
            automationExecutionRepository.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId,
        ).toHaveBeenCalledWith(startDate, endDate, teamAutomationId);
        expect(result).toEqual([
            { repositoryId: 'repo-1', pullRequestNumber: 101 },
        ]);
    });
});
