export interface StaleWorkflowJobReapResult {
    uuid: string;
    workflowType: string;
    organizationId: string | null;
    startedAt: Date | null;
    leaseExpiresAt?: Date | null;
    retryCount?: number;
    maxRetries?: number;
}

export interface IWorkflowJobRepository {
    create(job: any, transactionManager?: unknown): Promise<any>;
    /**
     * Update a job. An optional `guard` makes the write conditional on the
     * caller still owning the job's lease (#1830 review); in that mode the
     * method resolves `false` when nothing was written, i.e. the lease is gone.
     * The `noLiveOwner` form is for a caller that holds no lease at all and
     * must still not stamp over a live worker: it resolves `false` when a
     * running worker owns the row.
     */
    update(
        id: string,
        data: any,
        guard?:
            | { leaseOwner: string; requireProcessing?: boolean }
            | { noLiveOwner: true },
    ): Promise<any>;
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
    /**
     * Lists PROCESSING jobs owned by a dead/slow worker (issue #1830): rows
     * whose lease is EXPIRED (`leaseExpiresAt < now`) — a renewed lease means
     * the worker is alive and the job is left alone — OR, for legacy rows that
     * pre-date the lease, rows whose updatedAt is older than `olderThan`. This
     * lets the reaper detect a dead worker in ~90s instead of the 180-min
     * in-process timeout that dies with the process.
     */
    findStaleProcessing?(params: {
        now: Date;
        olderThan: Date;
    }): Promise<StaleWorkflowJobReapResult[]>;
    /**
     * Returns a reclaimed job to PENDING with retryCount incremented and the
     * lease/run state cleared so a fresh trigger re-processes it, instead of
     * permanently failing it.
     *
     * Returns the UUIDs of the jobs that were actually requeued (those that
     * were still PROCESSING at write time). The stale-job watchdog MUST
     * republish a broker message for exactly these — never for the full
     * candidate batch — because a job that finished (or was permanently
     * failed) between the SELECT and this UPDATE must not be re-driven.
     */
    requeueStaleJobs?(params: {
        uuids: string[];
        lastError: string;
        requeuedBy: string;
        // Tenant traceability: logged alongside the uuids so a reclaim can be
        // traced back to an organization in the log system.
        organizationIds?: string[];
    }): Promise<string[]>;
    /**
     * Terminally fails reclaimed jobs whose retry budget is exhausted.
     */
    failStaleJobs?(params: {
        uuids: string[];
        lastError: string;
        errorClassification: unknown;
    }): Promise<number>;
}

export const WORKFLOW_JOB_REPOSITORY_TOKEN = Symbol.for(
    'WorkflowJobRepository',
);
