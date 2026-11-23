import type { HostSealer } from './boat-setup-host';

// The live HostSealer of a template's setup host (docs/runtime/host-providers.md §8.2): no exec on the host. The hub
// asks the host's own cell to seal itself (cell.seal; the cell starts its seal unit, which stops the cell and removes
// identity, token file and /tmp). The seal is finished when that cell has gone, so this waits, bounded, for the hub
// to see it disconnected before the snapshot is taken.

export interface HubSealPort {
    /** Resolves once the host's cell acked cell.seal; throws when the hub refused (not a template host, claim live, not a fleet install). */
    seal(hostId: string): Promise<void>;
    connection(hostId: string): Promise<{ cellId: string | null; connected: boolean }>;
}

export class HubHostSealer implements HostSealer {
    constructor(
        private readonly deps: {
            hub: HubSealPort;
            poll: { sleep(ms: number): Promise<void>; attempts: number; intervalMs?: number };
        },
    ) {}

    async seal(req: { hostId: string; providerId: string }): Promise<void> {
        await this.deps.hub.seal(req.hostId);
        for (let i = 0; i < this.deps.poll.attempts; i++) {
            await this.deps.poll.sleep(this.deps.poll.intervalMs ?? 3_000);
            if (!(await this.deps.hub.connection(req.hostId)).connected) return;
        }
        throw new Error('seal_timeout');
    }
}
