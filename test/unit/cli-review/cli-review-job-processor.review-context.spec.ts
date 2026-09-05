import type { ExecuteCliReviewUseCase } from '@libs/cli-review/application/use-cases/execute-cli-review.use-case';
import { CliReviewJobProcessorService } from '@libs/cli-review/workflow/cli-review-job-processor.service';
import type { IRateLimitGateService } from '@libs/core/workflow/domain/contracts/rate-limit-gate.service.contract';
import type { IWorkflowJobRepository } from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import type { WorkflowEphemeralPayload } from '@libs/core/workflow/domain/types/workflow-ephemeral-payload';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

const reviewContext = {
    source: 'cli-review-context-file' as const,
    contentType: 'text/plain; charset=utf-8' as const,
    body: 'CANARY: inspect cleanup',
};

function makeJob() {
    return {
        id: 'job-cli-1',
        correlationId: 'correlation-1',
        status: JobStatus.PENDING,
        payload: {
            organizationAndTeamData: {
                organizationId: 'organization-1',
                teamId: 'team-1',
            },
            input: { diff: 'diff' },
        },
        metadata: {},
    };
}

describe('CliReviewJobProcessorService review context', () => {
    it('merges transient context only for the current execution', async () => {
        const repository = {
            findOne: jest.fn().mockResolvedValue(makeJob()),
            update: jest.fn().mockResolvedValue(undefined),
        } as unknown as jest.Mocked<IWorkflowJobRepository>;
        const execute = jest.fn().mockResolvedValue({
            summary: 'done',
            issues: [],
            filesAnalyzed: 1,
            duration: 1,
        });
        const processor = new CliReviewJobProcessorService(
            repository,
            { execute } as unknown as ExecuteCliReviewUseCase,
            {
                check: jest.fn().mockResolvedValue(undefined),
            } as unknown as IRateLimitGateService,
        );
        const ephemeralPayload: WorkflowEphemeralPayload = { reviewContext };

        await processor.process('job-cli-1', undefined, ephemeralPayload);
        await processor.process('job-cli-1');

        expect(execute).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                input: { diff: 'diff', reviewContext },
            }),
        );
        expect(execute).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ input: { diff: 'diff' } }),
        );
        expect(JSON.stringify(makeJob())).not.toContain(reviewContext.body);
    });
});
