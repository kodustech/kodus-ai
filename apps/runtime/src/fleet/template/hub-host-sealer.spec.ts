import { HubHostSealer, type HubSealPort } from './hub-host-sealer';

describe('HubHostSealer', () => {
    const make = (connected: boolean[], sealErr?: Error) => {
        const calls: string[] = [];
        const hub: HubSealPort = {
            seal: async (id) => {
                calls.push(`seal:${id}`);
                if (sealErr) throw sealErr;
            },
            connection: async (id) => {
                calls.push(`connection:${id}`);
                return { cellId: 'c', connected: connected.shift() ?? true };
            },
        };
        return { calls, sealer: new HubHostSealer({ hub, poll: { sleep: async () => undefined, attempts: 3 } }) };
    };

    it('asks the hub to seal, then returns only after the cell has disconnected', async () => {
        const { calls, sealer } = make([true, true, false]);
        await sealer.seal({ hostId: 'tpl-1', providerId: 'i-1' });
        expect(calls).toEqual(['seal:tpl-1', 'connection:tpl-1', 'connection:tpl-1', 'connection:tpl-1']);
    });

    it('fails with seal_timeout when the cell never disconnects, so no snapshot is taken', async () => {
        const { sealer } = make([true, true, true]);
        await expect(sealer.seal({ hostId: 'tpl-1', providerId: 'i-1' })).rejects.toThrow('seal_timeout');
    });

    it('fails without waiting when the hub refuses for good (not a template host, not a fleet cell)', async () => {
        const { calls, sealer } = make([], new Error('seal_refused_409'));
        await expect(sealer.seal({ hostId: 'tpl-1', providerId: 'i-1' })).rejects.toThrow('seal_refused_409');
        expect(calls).toEqual(['seal:tpl-1']);
    });

    // dev, 2026-11-26: the seal stopped the cell while the bake still exported its images, and the template kept an
    // empty catalog. The cell now refuses while it bakes; the sealer asks again until the bake is recorded.
    it('asks again while the cell is still baking, and seals once it is done', async () => {
        const calls: string[] = [];
        const busy = ['seal_busy_bake_running', 'seal_busy_bake_running'];
        const hub: HubSealPort = {
            seal: async (id) => {
                calls.push(`seal:${id}`);
                const why = busy.shift();
                if (why) throw new Error(why);
            },
            connection: async () => ({ cellId: 'c', connected: false }),
        };
        const slept: number[] = [];
        const sealer = new HubHostSealer({ hub, poll: { sleep: async (ms) => void slept.push(ms), attempts: 3 }, busy: { attempts: 5, intervalMs: 10_000 } });
        await sealer.seal({ hostId: 'tpl-1', providerId: 'i-1' });
        expect(calls).toEqual(['seal:tpl-1', 'seal:tpl-1', 'seal:tpl-1']);
        expect(slept.slice(0, 2)).toEqual([10_000, 10_000]);
    });

    it('gives up with seal_busy_timeout when the cell stays busy, so no snapshot is taken mid-bake', async () => {
        const hub: HubSealPort = { seal: async () => Promise.reject(new Error('seal_busy_bake_running')), connection: async () => ({ cellId: 'c', connected: true }) };
        const sealer = new HubHostSealer({ hub, poll: { sleep: async () => undefined, attempts: 3 }, busy: { attempts: 4, intervalMs: 1 } });
        await expect(sealer.seal({ hostId: 'tpl-1', providerId: 'i-1' })).rejects.toThrow('seal_busy_timeout');
    });
});
