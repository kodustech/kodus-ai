/** A workflow of the setup queue, as far as the turn of one environment's setups needs. */
export interface SetupWorkflowLite {
    workflowID: string;
    createdAt: number;
    status: string;
}

/**
 * What a setup does when it starts, given the other setups of its environment (workflow ids `setup:<environmentId>:...`):
 * - `wait`: an earlier setup is running, so it builds after it (the later one builds on the first's cache);
 * - `superseded`: none runs before it, but a newer one already runs or already ended, so this one's result would be
 *   the older one landing last: it ends without building and without writing a record;
 * - `go`: it is the environment's newest running setup.
 * A newer setup that is only queued does not supersede this one: it waits behind it.
 */
export type SetupTurn = 'wait' | 'superseded' | 'go';

export function setupTurn(me: SetupWorkflowLite, others: readonly SetupWorkflowLite[]): SetupTurn {
    const peers = others.filter((w) => w.workflowID !== me.workflowID && !w.workflowID.endsWith(':admission-rejected'));
    const isEarlier = (w: SetupWorkflowLite) => w.createdAt < me.createdAt || (w.createdAt === me.createdAt && w.workflowID < me.workflowID);
    if (peers.some((w) => isEarlier(w) && w.status === 'PENDING')) return 'wait';
    if (peers.some((w) => !isEarlier(w) && (w.status === 'PENDING' || w.status === 'SUCCESS'))) return 'superseded';
    return 'go';
}
