import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { AutomationExecutionService } from '@libs/automation/infrastructure/adapters/services/automationExecution.service';

describe('AutomationExecutionService', () => {
    const makeService = () => {
        const automationExecutionRepository = {} as any;
        const codeReviewExecutionService = {
            existsByAutomationExecutionAndStageStatus: jest.fn(),
            findManyByAutomationExecutionIds: jest.fn(),
        } as any;
        const cacheService = {} as any;

        const service = new AutomationExecutionService(
            automationExecutionRepository,
            codeReviewExecutionService,
            cacheService,
        );

        return { service, codeReviewExecutionService };
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
});
