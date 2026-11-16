import type { DBOS } from '@dbos-inc/dbos-sdk';

type RegisterQueueOptions = NonNullable<Parameters<typeof DBOS.registerQueue>[1]>;

/** What the worker's queues are sized from (WorkerConfig); the run-engine specs pass a part of it. */
export interface QueueLimitSettings {
    globalConcurrency: number;
    partitionConcurrency: number;
    setupPerOrg?: number;
    /** RUNTIME_SETUP_CONCURRENCY: setups at once across the app (default: globalConcurrency). */
    setupConcurrency?: number;
    /** RUNTIME_WORKER_CONCURRENCY: workflows one replica runs at once (default: no per-replica limit). */
    workerConcurrency?: number;
    durableAdmission?: boolean;
    admission?: { globalExecuting: number; perOrgExecuting: number; attemptConcurrency: number; attemptPerOrg: number };
}

type Registration = [name: string, options: RegisterQueueOptions];

/**
 * DBOS refuses a queue whose per-partition or per-replica limit is above its global one
 * (wfqueue.js validateQueueParameters), which failed the worker's launch: a partition or
 * replica limit is clamped to the global limit of its queue.
 */
function limited(global: number, partition: number | undefined, worker: number | undefined): RegisterQueueOptions {
    return {
        globalConcurrency: global,
        ...(partition !== undefined ? { partitionConcurrency: Math.min(partition, global) } : {}),
        ...(worker !== undefined ? { workerConcurrency: Math.min(worker, global) } : {}),
        onConflict: 'always_update',
    };
}

/**
 * The worker's DBOS queues and their limits. A replica runs at most workerConcurrency Runs
 * and setups at once, so one replica cannot take every global slot while its Postgres
 * pool (RUNTIME_PG_POOL_MAX) serves a share of them. Setups, which build and bake on a cell
 * at full size and may ask the LLM for a recipe, have a global limit of their own.
 */
export function queueRegistrations(c: QueueLimitSettings, names: { execution: string; admission: string; finalize: string; runs: string; setups: string }): Registration[] {
    if (c.durableAdmission && c.admission) {
        const a = c.admission;
        return [
            // Run and setup executions; the admission store holds setups to setupConcurrency (globalSetups).
            [names.execution, limited(a.globalExecuting, a.perOrgExecuting, c.workerConcurrency)],
            // Short attempts, no machine: no per-replica limit.
            [names.admission, limited(a.attemptConcurrency, a.attemptPerOrg, undefined)],
            [names.finalize, limited(a.attemptConcurrency, a.attemptPerOrg, undefined)],
        ];
    }
    const setups = Math.min(c.setupConcurrency ?? c.globalConcurrency, c.globalConcurrency);
    return [
        [names.runs, limited(c.globalConcurrency, c.partitionConcurrency, c.workerConcurrency)],
        [names.setups, limited(setups, c.setupPerOrg, c.workerConcurrency)],
    ];
}
