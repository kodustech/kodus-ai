import {
    GraphJobAttempt,
    StaleGraphJobError,
} from '@libs/code-review/domain/graph-job-attempt';
import type { IWorkflowJobRepository } from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { ClaimConflictError } from '@libs/core/workflow/domain/errors/claim-conflict.error';
import type { IWorkflowJob } from '@libs/core/workflow/domain/interfaces/workflow-job.interface';

export async function claimGraphJob(
    jobs: IWorkflowJobRepository,
    job: IWorkflowJob,
    attempt: GraphJobAttempt,
    timeoutMs: number,
): Promise<boolean> {
    if (job.status === JobStatus.PROCESSING) {
        // A redelivery may take over a crashed worker after its router deadline.
        const since = job.startedAt ?? job.updatedAt;
        if (!since || Date.now() - since.getTime() < timeoutMs)
            throw new ClaimConflictError(
                'Another attempt is building this graph',
            );
    } else if (
        job.status !== JobStatus.PENDING &&
        job.status !== JobStatus.FAILED
    ) {
        return false;
    }
    const previous = job.metadata?.attemptId;
    return (
        (await jobs.update(
            attempt.jobId,
            {
                status: JobStatus.PROCESSING,
                startedAt: new Date(),
                completedAt: null,
                lastError: null,
                errorClassification: null,
                currentStage: 'VALIDATING',
                metadata: { attemptId: attempt.attemptId, stage: 'VALIDATING' },
            },
            job.status,
            typeof previous === 'string' ? previous : null,
        )) !== null
    );
}

export async function updateGraphJobStage(
    jobs: IWorkflowJobRepository,
    { jobId, attemptId }: GraphJobAttempt,
    stage: string,
    extra?: Record<string, unknown>,
): Promise<void> {
    const updated = await jobs.update(
        jobId,
        {
            status: JobStatus.PROCESSING,
            currentStage: stage,
            metadata: { attemptId, stage, ...extra },
        },
        JobStatus.PROCESSING,
        attemptId,
    );
    if (updated === null) throw new StaleGraphJobError(jobId);
}
