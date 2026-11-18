import { DBOS } from '@dbos-inc/dbos-sdk';

import type { FleetConfig } from '../shared/config';
import { dbosWorkflowHistory, pruneWorkflowHistory, type WorkflowHistory } from '../shared/persistence/workflow-retention';
import { type PerRunHostDeps, type PerRunHostInput, runPerRunHost } from './per-run-host';

// The fleet's own DBOS application (docs/runtime/host-providers.md §4.1):
// its name and system database are not the worker's, so the two never
// recover each other's workflows. One workflow per host, keyed by its id.

export const PER_RUN_WORKFLOW = 'fleet.perRun';
export const perRunWorkflowId = (hostId: string) => `${PER_RUN_WORKFLOW}:${hostId}`;
export const FLEET_DBOS_APP = 'kody-runtime-fleet';

export class FleetEngine {
    private readonly perRun: (input: PerRunHostInput) => Promise<unknown>;
    private launched = false;

    constructor(
        private readonly config: Pick<FleetConfig, 'systemDatabaseUrl' | 'releaseVersion' | 'dbosLogLevel' | 'executorId'>,
        deps: Omit<PerRunHostDeps, 'step' | 'sleep' | 'now'>,
    ) {
        this.perRun = DBOS.registerWorkflow(
            async (input: PerRunHostInput) =>
                runPerRunHost(input, { ...deps, step: (name, fn, retry) => DBOS.runStep(fn, retry ? { name, retriesAllowed: true, ...retry } : { name }), sleep: (ms) => DBOS.sleep(ms), now: () => Date.now() }),
            { name: PER_RUN_WORKFLOW },
        );
    }

    async launch() {
        DBOS.setConfig({
            name: FLEET_DBOS_APP,
            systemDatabaseUrl: this.config.systemDatabaseUrl,
            logLevel: this.config.dbosLogLevel,
            applicationVersion: this.config.releaseVersion,
            ...(this.config.executorId ? { executorID: this.config.executorId } : {}),
        });
        await DBOS.launch();
        this.launched = true;
    }

    /** Starts the host's workflow; a second start of the same host returns the first. */
    async start(input: PerRunHostInput) {
        await DBOS.startWorkflow(this.perRun, { workflowID: perRunWorkflowId(input.hostId) })(input);
    }

    async shutdown() {
        if (this.launched) await DBOS.shutdown();
    }
}

/** The host a fleet workflow belongs to: its id after `fleet.perRun:`; undefined for any other workflow. */
export const hostIdOfWorkflowId = (workflowID: string) => (workflowID.startsWith(`${PER_RUN_WORKFLOW}:`) ? workflowID.slice(PER_RUN_WORKFLOW.length + 1) : undefined);

/**
 * One retention pass over the fleet's own DBOS history (v-core N10): its
 * terminal workflows past the worker's age (30 days, at least 8, past a
 * teardown's 24 h), never one whose host is still live in runtime_hosts,
 * since a second start of a live host must find its first workflow.
 */
export async function pruneFleetHistory(
    store: { liveHosts(): Promise<Array<{ hostId: string }>> },
    now: Date,
    history: WorkflowHistory = dbosWorkflowHistory,
) {
    const live = new Set((await store.liveHosts()).map((h) => h.hostId));
    // A workflow the fleet did not name (none today) is kept.
    return pruneWorkflowHistory(history, { now, isLive: (id) => { const host = hostIdOfWorkflowId(id); return host === undefined || live.has(host); } });
}
