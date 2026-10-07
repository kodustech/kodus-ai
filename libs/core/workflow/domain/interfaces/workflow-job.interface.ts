import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { ErrorClassification } from '../enums/error-classification.enum';
import { HandlerType } from '../enums/handler-type.enum';
import { JobStatus } from '../enums/job-status.enum';
import { WorkflowType } from '../enums/workflow-type.enum';

export interface IWorkflowJob {
    id: string;
    correlationId: string;
    workflowType: WorkflowType;
    handlerType: HandlerType;
    payload: Record<string, unknown>;
    status: JobStatus;
    priority: number;
    retryCount: number;
    maxRetries: number;
    organizationAndTeamData?: OrganizationAndTeamData;
    errorClassification?: ErrorClassification;
    lastError?: string;
    scheduledAt?: Date;
    startedAt?: Date;
    completedAt?: Date;
    currentStage?: string;
    // Lease on job ownership (issue #1830): the worker processing the job
    // renews `leaseExpiresAt` on a ~30s cadence and stamps `leaseOwner`. The
    // stale-job reaper reclaims PROCESSING jobs by an EXPIRED lease (or, for
    // pre-lease rows, by age), which detects a dead worker in ~90s instead of
    // waiting out the 180-min in-process timeout that dies with the process.
    leaseOwner?: string;
    leaseExpiresAt?: Date;
    metadata?: Record<string, unknown>;
    waitingForEvent?: {
        eventType: string; // e.g., 'ast.task.completed'
        eventKey: string; // e.g., taskId
        timeout: number; // milliseconds
        pausedAt: Date;
    };
    pipelineState?: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
}
