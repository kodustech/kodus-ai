export interface StaleWorkflowJobReapResult {
    uuid: string;
    workflowType: string;
    organizationId: string | null;
    startedAt: Date | null;
}

export interface IWorkflowJobRepository {
    create(job: any, transactionManager?: unknown): Promise<any>;
    update(id: string, data: any): Promise<any>;
    findOne(id: string): Promise<any>;
    findMany(query: any): Promise<{ data: any[]; total?: number }>;
    prunePayloadForFinalizedJobs?(params: {
        olderThan: Date;
        limit?: number;
    }): Promise<number>;
    /**
     * Reaps jobs orphaned in PROCESSING (worker SIGKILLed before any
     * terminal update). Flips PROCESSING rows whose updatedAt is older than
     * `olderThan` to FAILED and returns the reaped rows for logging.
     */
    failStaleProcessing?(params: {
        olderThan: Date;
        lastError: string;
        errorClassification: unknown;
    }): Promise<StaleWorkflowJobReapResult[]>;
    failEphemeralJob(
        id: string,
        params: {
            lastError: string;
            errorClassification: unknown;
        },
    ): Promise<boolean>;
    failStaleEphemeralPending(params: {
        olderThan: Date;
        lastError: string;
        errorClassification: unknown;
    }): Promise<StaleWorkflowJobReapResult[]>;
}

export const WORKFLOW_JOB_REPOSITORY_TOKEN = Symbol.for(
    'WorkflowJobRepository',
);
