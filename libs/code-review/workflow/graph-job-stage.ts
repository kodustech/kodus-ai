import {
    GraphJobAttempt,
    StaleGraphJobError,
} from '@libs/code-review/domain/graph-job-attempt';
import type { IWorkflowJobRepository } from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';

export async function updateGraphJobStage(
    jobs: IWorkflowJobRepository,
    { jobId, attemptId }: GraphJobAttempt,
    stage: string,
    extra?: Record<string, unknown>,
): Promise<boolean> {
    const starting = stage === 'VALIDATING';
    const updated = await jobs.update(
        jobId,
        {
            status: JobStatus.PROCESSING,
            ...(starting && { startedAt: new Date() }),
            currentStage: stage,
            metadata: { attemptId, stage, ...extra },
        },
        starting
            ? [JobStatus.PENDING, JobStatus.FAILED, JobStatus.PROCESSING]
            : JobStatus.PROCESSING,
        starting ? undefined : attemptId,
    );
    if (!starting && updated === null) throw new StaleGraphJobError(jobId);
    return updated !== null;
}
