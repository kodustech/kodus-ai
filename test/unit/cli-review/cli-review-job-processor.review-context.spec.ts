import type { ExecuteCliReviewUseCase } from '@libs/cli-review/application/use-cases/execute-cli-review.use-case';
import { redactReviewContextFromResponse } from '@libs/cli-review/pipeline/stages/format-cli-output.stage';
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
    it('merges transient context only for the current execution without mutating or persisting it', async () => {
        const repositoryJob = makeJob();
        const repository = {
            findOne: jest.fn().mockResolvedValue(repositoryJob),
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
        expect(JSON.stringify(repositoryJob)).not.toContain(reviewContext.body);
        for (const write of repository.update.mock.calls) {
            expect(JSON.stringify(write)).not.toContain(reviewContext.body);
        }
    });

    it('persists the filtered response without the packet or a substantial standalone echo', async () => {
        const packet = {
            ...reviewContext,
            body: 'alpha beta secretalpha gamma delta epsilon',
        };
        const repository = {
            findOne: jest.fn().mockResolvedValue(makeJob()),
            update: jest.fn().mockResolvedValue(undefined),
        } as unknown as jest.Mocked<IWorkflowJobRepository>;
        const response = redactReviewContextFromResponse(
            {
                summary: 'Found one issue',
                issues: [
                    {
                        file: 'src/index.ts',
                        line: 1,
                        severity: 'high',
                        category: 'bug',
                        message: 'secretalpha',
                        ruleId: 'rule-x',
                    },
                ],
                filesAnalyzed: 1,
                duration: 1,
            },
            packet.body,
        );
        const execute = jest.fn().mockResolvedValue(response);
        const processor = new CliReviewJobProcessorService(
            repository,
            { execute } as unknown as ExecuteCliReviewUseCase,
            {
                check: jest.fn().mockResolvedValue(undefined),
            } as unknown as IRateLimitGateService,
        );

        await processor.process('job-cli-1', undefined, {
            reviewContext: packet,
        });

        const writes = JSON.stringify(repository.update.mock.calls);
        expect(writes).not.toContain(packet.body);
        expect(writes).not.toContain('secretalpha');
        expect(writes).toContain('[review context redacted]');
        expect(writes).toContain('rule-x');
    });

    it('rejects malformed ephemeral context before use-case execution', async () => {
        const repository = {
            findOne: jest.fn().mockResolvedValue(makeJob()),
            update: jest.fn().mockResolvedValue(undefined),
        } as unknown as jest.Mocked<IWorkflowJobRepository>;
        const execute = jest.fn();
        const processor = new CliReviewJobProcessorService(
            repository,
            { execute } as unknown as ExecuteCliReviewUseCase,
            {
                check: jest.fn().mockResolvedValue(undefined),
            } as unknown as IRateLimitGateService,
        );

        await expect(
            processor.process('job-cli-1', undefined, {
                reviewContext: { ...reviewContext, body: null },
            }),
        ).rejects.toThrow('Invalid ephemeral review context');

        expect(execute).not.toHaveBeenCalled();
    });
});
