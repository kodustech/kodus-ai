import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { AUTOMATION_EXECUTION_SERVICE_TOKEN } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import {
    CheckConclusion,
    CheckStatus,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { ChecksAdapterFactory } from '@libs/core/infrastructure/pipeline/services/checks-adapter.factory';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { Test, TestingModule } from '@nestjs/testing';
import { StaleReviewWatchdogCronProvider } from './staleReviewWatchdog.cron';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: jest.fn().mockReturnValue({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

describe('StaleReviewWatchdogCronProvider', () => {
    let provider: StaleReviewWatchdogCronProvider;
    let automationExecutionService: {
        findStaleInProgress: jest.Mock;
        updateCodeReview: jest.Mock;
        finalizeInProgressStageLogs: jest.Mock;
    };
    let checksAdapter: { updateCheckRun: jest.Mock };
    let lock: { release: jest.Mock };
    let distributedLockService: { acquire: jest.Mock };

    const staleExecutionWithCheck = {
        uuid: 'stale-uuid-1',
        pullRequestNumber: 42,
        repositoryId: 'repo-1',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        dataExecution: {
            platformType: 'GITHUB',
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            checkRun: {
                id: 123456,
                headSha: 'abc123',
                repository: { owner: 'owner', name: 'repo' },
            },
        },
    };

    const staleExecutionWithoutCheck = {
        uuid: 'stale-uuid-2',
        pullRequestNumber: 43,
        repositoryId: 'repo-1',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        dataExecution: {
            platformType: 'GITHUB',
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        },
    };

    beforeEach(async () => {
        automationExecutionService = {
            findStaleInProgress: jest.fn().mockResolvedValue([]),
            updateCodeReview: jest.fn().mockResolvedValue({}),
            finalizeInProgressStageLogs: jest.fn().mockResolvedValue(0),
        };
        checksAdapter = {
            updateCheckRun: jest.fn().mockResolvedValue(true),
        };
        lock = { release: jest.fn() };
        distributedLockService = {
            acquire: jest.fn().mockResolvedValue(lock),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                StaleReviewWatchdogCronProvider,
                {
                    provide: AUTOMATION_EXECUTION_SERVICE_TOKEN,
                    useValue: automationExecutionService,
                },
                {
                    provide: ChecksAdapterFactory,
                    useValue: {
                        getAdapter: jest.fn().mockReturnValue(checksAdapter),
                    },
                },
                {
                    provide: DistributedLockService,
                    useValue: distributedLockService,
                },
            ],
        }).compile();

        provider = module.get(StaleReviewWatchdogCronProvider);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('does nothing when the lock is not acquired', async () => {
        distributedLockService.acquire.mockResolvedValue(null);

        await provider.handleCron();

        expect(
            automationExecutionService.findStaleInProgress,
        ).not.toHaveBeenCalled();
    });

    it('does nothing when there are no stale executions', async () => {
        await provider.handleCron();

        expect(
            automationExecutionService.updateCodeReview,
        ).not.toHaveBeenCalled();
        expect(lock.release).toHaveBeenCalled();
    });

    it('marks stale executions as error and finalizes the orphaned check run', async () => {
        automationExecutionService.findStaleInProgress.mockResolvedValue([
            staleExecutionWithCheck,
        ]);
        automationExecutionService.finalizeInProgressStageLogs.mockResolvedValue(
            2,
        );

        await provider.handleCron();

        expect(
            automationExecutionService.finalizeInProgressStageLogs,
        ).toHaveBeenCalledWith(
            'stale-uuid-1',
            AutomationStatus.ERROR,
            expect.any(String),
        );

        expect(
            automationExecutionService.updateCodeReview,
        ).toHaveBeenCalledWith(
            { uuid: 'stale-uuid-1' },
            expect.objectContaining({ status: AutomationStatus.ERROR }),
            expect.any(String),
            'Kody Review Finished',
        );

        expect(checksAdapter.updateCheckRun).toHaveBeenCalledWith(
            expect.objectContaining({
                checkRunId: 123456,
                repository: { owner: 'owner', name: 'repo' },
                status: CheckStatus.COMPLETED,
                conclusion: CheckConclusion.FAILURE,
            }),
        );
        expect(lock.release).toHaveBeenCalled();
    });

    it('reaps executions without persisted check run info (legacy rows)', async () => {
        automationExecutionService.findStaleInProgress.mockResolvedValue([
            staleExecutionWithoutCheck,
        ]);

        await provider.handleCron();

        expect(
            automationExecutionService.updateCodeReview,
        ).toHaveBeenCalledWith(
            { uuid: 'stale-uuid-2' },
            expect.objectContaining({ status: AutomationStatus.ERROR }),
            expect.any(String),
            'Kody Review Finished',
        );
        expect(checksAdapter.updateCheckRun).not.toHaveBeenCalled();
    });

    it('keeps reaping remaining executions when one fails', async () => {
        automationExecutionService.findStaleInProgress.mockResolvedValue([
            staleExecutionWithCheck,
            staleExecutionWithoutCheck,
        ]);
        automationExecutionService.updateCodeReview
            .mockRejectedValueOnce(new Error('db error'))
            .mockResolvedValueOnce({});

        await provider.handleCron();

        expect(
            automationExecutionService.updateCodeReview,
        ).toHaveBeenCalledTimes(2);
        expect(lock.release).toHaveBeenCalled();
    });
});
