import {
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
} from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';

import { CliReviewResponse } from '@libs/cli-review/domain/types/cli-review.types';

const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 5_000;
// Cap matches the worker's own job timeout — we don't want to hold the
// HTTP connection longer than the worker can possibly take to finish.
const MAX_WAIT_MS = 30 * 60 * 1000;

export interface WaitForCliReviewJobInput {
    jobId: string;
}

/**
 * Synchronous polling for a CLI review job, used by the legacy non-async
 * `POST /cli/review` path that returns the full result inline. Backs off
 * exponentially up to MAX_DELAY_MS so we don't hammer the queue store.
 * Throws platform exceptions (`NotFound` / `InternalServerError` /
 * `GatewayTimeout`) so the controller returns the matching HTTP code
 * without extra translation.
 */
@Injectable()
export class WaitForCliReviewJobUseCase
    implements IUseCase<WaitForCliReviewJobInput, CliReviewResponse>
{
    constructor(
        @Inject(JOB_QUEUE_SERVICE_TOKEN)
        private readonly jobQueueService: IJobQueueService,
    ) {}

    async execute(input: WaitForCliReviewJobInput): Promise<CliReviewResponse> {
        const { jobId } = input;
        const startedAt = Date.now();
        let delayMs = MIN_DELAY_MS;

        while (Date.now() - startedAt < MAX_WAIT_MS) {
            const job = await this.jobQueueService.getStatus(jobId);
            if (!job) {
                throw new HttpException(
                    `CLI review job ${jobId} not found`,
                    HttpStatus.NOT_FOUND,
                );
            }

            if (job.status === JobStatus.COMPLETED) {
                const result = (job.metadata as any)?.result as
                    | CliReviewResponse
                    | undefined;
                if (!result) {
                    throw new HttpException(
                        'CLI review completed but result is missing',
                        HttpStatus.INTERNAL_SERVER_ERROR,
                    );
                }
                return result;
            }

            if (job.status === JobStatus.FAILED) {
                throw new HttpException(
                    job.lastError || 'CLI review job failed',
                    HttpStatus.INTERNAL_SERVER_ERROR,
                );
            }

            await new Promise((resolve) => setTimeout(resolve, delayMs));
            delayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
        }

        throw new HttpException(
            `CLI review job ${jobId} did not finish within ${MAX_WAIT_MS}ms`,
            HttpStatus.GATEWAY_TIMEOUT,
        );
    }
}
