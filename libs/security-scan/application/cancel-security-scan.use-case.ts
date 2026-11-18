import {
    ConflictException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { isValidObjectId } from 'mongoose';

import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';

import {
    SecurityScanRecord,
    SecurityScanStatus,
} from '../domain/security-scan.types';
import {
    ISecurityScanRepository,
    SECURITY_SCAN_REPOSITORY_TOKEN,
} from '../infrastructure/security-scan.repository';

export const SCAN_NOT_CANCELLABLE_MESSAGE =
    'Only a queued or running scan can be cancelled.';

const CANCELLABLE = [SecurityScanStatus.QUEUED, SecurityScanStatus.RUNNING];

@Injectable()
export class CancelSecurityScanUseCase {
    constructor(
        @Inject(SECURITY_SCAN_REPOSITORY_TOKEN)
        private readonly scans: ISecurityScanRepository,
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobs: IWorkflowJobRepository,
    ) {}

    async execute(input: {
        organizationId: string;
        scanId: string;
    }): Promise<SecurityScanRecord> {
        const scan = isValidObjectId(input.scanId)
            ? await this.scans.findById(input.scanId)
            : null;
        if (!scan || scan.organizationId !== input.organizationId) {
            throw new NotFoundException('Security scan not found.');
        }
        if (!CANCELLABLE.includes(scan.status)) {
            throw new ConflictException(SCAN_NOT_CANCELLABLE_MESSAGE);
        }

        const updated = await this.scans.update(
            scan.uuid,
            {
                status: SecurityScanStatus.CANCELLED,
                finishedAt: new Date().toISOString(),
            },
            undefined,
            { statuses: CANCELLABLE },
        );
        if (!updated) {
            throw new ConflictException(SCAN_NOT_CANCELLABLE_MESSAGE);
        }

        // The scan record is what locks the repository. A job left PENDING
        // is skipped by the processor once it arrives; marking it cancelled
        // keeps it from looking stuck.
        await this.cancelJobs(scan.uuid).catch(() => undefined);
        return updated;
    }

    private async cancelJobs(scanId: string): Promise<void> {
        for (const status of [JobStatus.PENDING, JobStatus.PROCESSING]) {
            const { data } = await this.jobs.findMany({
                correlationId: scanId,
                workflowType: WorkflowType.SECURITY_SCAN,
                status,
                limit: 20,
            });
            for (const job of data) {
                await this.jobs.update(job.id, {
                    status: JobStatus.CANCELLED,
                    completedAt: new Date(),
                });
            }
        }
    }
}
