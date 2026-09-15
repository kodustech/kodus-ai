import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { ErrorClassification } from '../enums/error-classification.enum';
import { HandlerType } from '../enums/handler-type.enum';
import { JobStatus } from '../enums/job-status.enum';
import { WorkflowType } from '../enums/workflow-type.enum';

export interface IWorkflowJob {
    id: string;
    correlationId: string;
    /** Stable producer key used to collapse duplicate workflow submissions. */
    idempotencyKey?: string;
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
