import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';

export interface PipelineContext {
    statusInfo: {
        status: AutomationStatus;
        message?: string;
        jumpToStage?: string;
        /**
         * Names of stages the executor should bypass when reached. Unlike
         * `jumpToStage` (which fast-forwards then resumes), entries here
         * exclude specific stages while the rest of the pipeline runs
         * normally. Status stays IN_PROGRESS.
         */
        skipStages?: string[];
        skippedReason?: {
            status: AutomationStatus;
            message?: string;
            stageName?: string;
            jumpToStage?: string;
        };
    };
    pipelineVersion: string;
    errors: PipelineError[];
    pipelineMetadata?: {
        pipelineId?: string;
        pipelineName?: string;
        parentPipelineId?: string;
        rootPipelineId?: string;
        [key: string]: any;
    };
    workflowJobId?: string;
}

/**
 * Criticality of a stage error when deciding the final pipeline conclusion.
 *
 * - 'critical' (default): failing this stage should mark the pipeline as
 *   ERROR and the platform check as FAILURE. Used for stages whose failure
 *   compromises the review's primary output (e.g. posting file comments,
 *   fetching files, agent review).
 * - 'partial': failing this stage should leave the pipeline in
 *   PARTIAL_ERROR / NEUTRAL — the review still has value, but something
 *   degraded. Used for auxiliary stages (business-logic validation,
 *   PR-level comments, verify, summary).
 */
export type PipelineErrorSeverity = 'critical' | 'partial';

export interface PipelineError {
    pipelineId?: string;
    stage: string;
    substage?: string;
    error: Error;
    severity?: PipelineErrorSeverity;
    metadata?: any;
}
