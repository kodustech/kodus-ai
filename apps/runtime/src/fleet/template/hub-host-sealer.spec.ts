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

    it('fails without waiting when the hub refuses (a claim is live, not a template host)', async () => {
        const { calls, sealer } = make([], new Error('hub fleet seal answered 409'));
        await expect(sealer.seal({ hostId: 'tpl-1', providerId: 'i-1' })).rejects.toThrow('409');
        expect(calls).toEqual(['seal:tpl-1']);
    });
});
