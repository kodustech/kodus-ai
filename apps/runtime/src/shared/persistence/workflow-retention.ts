import { DBOS } from '@dbos-inc/dbos-sdk';

// Retention of DBOS's own history (P7). DBOS keeps every workflow's status,
// its input (a Run's carries the PR's diff) and every step's output until
// something deletes them, and nothing did: the system tables grew with every
// Run, and the queue's own scans ran over them. The worker deletes terminal
// workflows past an age, from the maintenance tick, in bounded batches.
//
// A workflow is deleted only when it is terminal (DBOS never runs it again)
// and older than the longest any workflow of the Runtime lives (a fork's gate
// waits 7 days for approval), and never while the Run it belongs to is still
// live in the projection: the sweep reads a live Run's workflow to stop it.

/** The statuses DBOS never runs again (workflow.d.ts StatusString). */
export const TERMINAL_WORKFLOW_STATUSES = ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'] as const;

const DAY_MS = 24 * 3_600_000;

export interface WorkflowRetentionOptions {
    /** How old a terminal workflow is, from its creation, before it is deleted. */
    maxAgeMs: number;
    /** Workflows listed and deleted per batch: one DBOS transaction each, its steps' rows included. */
    batch: number;
    /** Batches (pages read) per pass, at most: the rest waits for the next pass (hourly). */
    maxBatches: number;
    /** A pass stops starting batches past this time, so it never holds the maintenance lock long. */
    budgetMs: number;
}

/**
 * 30 days; 100 workflows a transaction (a Run writes about 100 step rows, so
 * about 10 k rows each); 20 batches, so 2 000 workflows an hour, about 48 k a
 * day, well above what 1 k Runs a day leave; 30 s at most per pass.
 */
export const WORKFLOW_RETENTION_DEFAULTS: WorkflowRetentionOptions = { maxAgeMs: 30 * DAY_MS, batch: 100, maxBatches: 20, budgetMs: 30_000 };

/** The least age accepted: past the 7 days a fork's gate waits, with a margin. */
export const MIN_WORKFLOW_AGE_MS = 8 * DAY_MS;

export interface WorkflowRow {
    workflowID: string;
    status: string;
    /** Epoch ms. */
    createdAt: number;
}

/** What retention needs of DBOS: the oldest terminal workflows first, and a delete by id. */
export interface WorkflowHistory {
    listTerminal(createdBefore: Date, limit: number, offset: number): Promise<WorkflowRow[]>;
    delete(workflowIDs: string[]): Promise<void>;
}

/** DBOS's system database through its public API: no input or output is loaded, and only the listed workflows are deleted (not their children). */
export const dbosWorkflowHistory: WorkflowHistory = {
    listTerminal: async (createdBefore, limit, offset) =>
        (await DBOS.listWorkflows({ status: [...TERMINAL_WORKFLOW_STATUSES], endTime: createdBefore.toISOString(), limit, offset, loadInput: false, loadOutput: false })).map((w) => ({
            workflowID: w.workflowID,
            status: w.status,
            createdAt: w.createdAt,
        })),
    delete: (ids) => DBOS.deleteWorkflows(ids, false),
};

/** The Run a workflow belongs to: its own id, or with the suffix of its approved fork Run (`:run`) or its stop (`:stop`). */
export const runIdOfWorkflowId = (workflowID: string) => workflowID.replace(/:(run|stop)$/, '');

export interface PruneResult {
    deleted: number;
    /** Old terminal workflows left because their Run is still live. */
    kept: number;
    batches: number;
    /** The pass stopped at its cap or its budget with old workflows left. */
    more: boolean;
}

/**
 * One retention pass: lists the oldest terminal workflows created before
 * now − maxAgeMs, a batch at a time, and deletes those whose Run is not live.
 * Kept workflows are read past (offset), so a page of live Runs never stalls it.
 */
export async function pruneWorkflowHistory(
    history: WorkflowHistory,
    args: { now: Date; isLive: (runId: string) => boolean; options?: Partial<WorkflowRetentionOptions>; clock?: () => number },
): Promise<PruneResult> {
    const o = { ...WORKFLOW_RETENTION_DEFAULTS, ...args.options };
    if (!(o.maxAgeMs >= MIN_WORKFLOW_AGE_MS)) throw new Error(`workflow retention age must be at least ${MIN_WORKFLOW_AGE_MS / DAY_MS} days`);
    const clock = args.clock ?? Date.now;
    const began = clock();
    const before = new Date(args.now.getTime() - o.maxAgeMs);
    const result: PruneResult = { deleted: 0, kept: 0, batches: 0, more: false };
    // Pages read, deleting or not: the cap bounds the reads too, when a page holds only live Runs.
    for (let pages = 0; ; pages++) {
        if (pages >= o.maxBatches || clock() - began >= o.budgetMs) {
            result.more = (await history.listTerminal(before, 1, result.kept)).length > 0;
            return result;
        }
        const page = await history.listTerminal(before, o.batch, result.kept);
        if (!page.length) return result;
        const doomed = page.filter((w) => (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(w.status) && !args.isLive(runIdOfWorkflowId(w.workflowID)));
        result.kept += page.length - doomed.length;
        if (doomed.length) {
            await history.delete(doomed.map((w) => w.workflowID));
            result.deleted += doomed.length;
            result.batches++;
        }
        if (page.length < o.batch) return result;
    }
}
