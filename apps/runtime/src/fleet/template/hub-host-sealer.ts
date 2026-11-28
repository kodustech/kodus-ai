import type { HostSealer } from './boat-setup-host';

// The live HostSealer of a template's setup host (docs/runtime/host-providers.md §8.2): no exec on the host. The hub
// asks the host's own cell to seal itself (cell.seal; the cell starts its seal unit, which stops the cell and removes
// identity, token file and /tmp). The seal is finished when that cell has gone, so this waits, bounded, for the hub
// to see it disconnected before the snapshot is taken. A cell still working refuses the seal (a bake in progress: the
// setup claim is released once the bake is acked, minutes before the bake has recorded its images), so the seal is
// asked again until it is taken, bounded too: a seal that stopped the cell mid-bake saved a template with no bake.

export interface HubSealPort {
    /**
     * Resolves once the host's cell acked cell.seal; throws an Error whose message is a short code: `seal_busy_<why>` while
     * the cell is still working (a bake in progress, a claim live), `seal_refused_<status>` when the hub refused for good
     * (not a template host, not a fleet install), `hub_unreachable` when it could not be reached.
     */
    seal(hostId: string): Promise<void>;
    connection(hostId: string): Promise<{ cellId: string | null; connected: boolean }>;
}

/** How long a busy cell is asked again: every 10 s for 30 minutes, well past a bake's export of an environment's images. */
const BUSY_DEFAULT = { attempts: 180, intervalMs: 10_000 };

export class HubHostSealer implements HostSealer {
    constructor(
        private readonly deps: {
            hub: HubSealPort;
            poll: { sleep(ms: number): Promise<void>; attempts: number; intervalMs?: number };
            busy?: { attempts: number; intervalMs: number };
        },
    ) {}

    async seal(req: { hostId: string; providerId: string }): Promise<void> {
        await this.askUntilTaken(req.hostId);
        for (let i = 0; i < this.deps.poll.attempts; i++) {
            await this.deps.poll.sleep(this.deps.poll.intervalMs ?? 3_000);
            if (!(await this.deps.hub.connection(req.hostId)).connected) return;
        }
        throw new Error('seal_timeout');
    }

    private async askUntilTaken(hostId: string): Promise<void> {
        const busy = this.deps.busy ?? BUSY_DEFAULT;
        for (let i = 1; ; i++) {
            try {
                return await this.deps.hub.seal(hostId);
            } catch (e) {
                if (!(e instanceof Error) || !e.message.startsWith('seal_busy_')) throw e;
                if (i >= busy.attempts) throw new Error('seal_busy_timeout', { cause: e });
                await this.deps.poll.sleep(busy.intervalMs);
            }
        }
    }
}
