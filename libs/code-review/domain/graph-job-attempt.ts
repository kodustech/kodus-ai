import { ClaimConflictError } from '@libs/core/workflow/domain/errors/claim-conflict.error';

export const AST_GRAPH_BUILD_TIMEOUT_MS = 19 * 60 * 1000;
export const AST_GRAPH_INCREMENTAL_TIMEOUT_MS = 9 * 60 * 1000;

export interface GraphJobAttempt {
    jobId: string;
    attemptId: string;
}

export class StaleGraphJobError extends Error {
    constructor(jobId: string) {
        super(`Graph job ${jobId} is no longer processing this attempt`);
    }
}

export class GraphBaselineChangedError extends ClaimConflictError {
    constructor() {
        super('Graph baseline changed. Retrying with a fresh checkout');
    }
}
