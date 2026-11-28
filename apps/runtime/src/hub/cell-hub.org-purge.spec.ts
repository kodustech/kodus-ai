import { randomUUID } from 'crypto';

import { decodeFrame, PROTOCOL_VERSION } from '@libs/runtime/protocol';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { createCa } from './ca/x509';
import { CellCredential, CellHub } from './cell-hub';
import { InMemoryHubStore } from './testing';

// The cell leg of the org purge (docs/runtime/persistent-state.md D13): org.purge to every connected cell that may
// hold data of the org, org.purged back per cell, and the status the worker's purge waits on.

class FakeSocket {
    sent: any[] = [];
    send(d: string) {
        const r = decodeFrame(d);
        if ('code' in r) throw new Error(`hub sent an invalid frame: ${r.code} ${r.message}`);
        this.sent.push(r.message);
    }
    close() {}
    all(type: string) {
        return this.sent.filter((m) => m.type === type);
    }
}

const frame = (cellId: string, type: string, body: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), cellId, type, body, ...extra });
const CA = createCa('org purge spec CA');
const tick = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

function setup() {
    const hub = new CellHub(new InMemoryHubStore(), new InMemoryRunStreamStore(), new RuntimeMetrics(), { replicaId: 'r1', replicaUrl: 'http://hub', ca: CA, log: () => undefined });
    const connect = async (cellId: string, features: string[], cred: Partial<CellCredential> = {}) => {
        const sock = new FakeSocket();
        const owner = cred.owner ?? 'kodus';
        const h = hub.attach(sock, { cellId, owner, ...cred });
        await h.onMessage(frame(cellId, 'hello', { versions: [1], driver: 'docker-gvisor', isolation: 'sandboxed-container', regions: ['local'], owner, features }));
        return { cellId, sock, ...h };
    };
    /** Runs the purge request while each given cell answers what its script says to the org.purge it gets. */
    const purge = async (orgId: string, answers: Array<[Awaited<ReturnType<typeof connect>>, 'ack' | 'busy']>) => {
        const p = hub.purgeOrganizationData(orgId);
        await tick();
        for (const [c, how] of answers) {
            const req = c.sock.all('org.purge').at(-1);
            if (!req) continue;
            await c.onMessage(frame(c.cellId, how === 'ack' ? 'ack' : 'nack', how === 'ack' ? {} : { code: 'org_busy', message: 'a claim is live' }, { re: req.id }));
        }
        return p;
    };
    const purged = (c: Awaited<ReturnType<typeof connect>>, orgId: string) => c.onMessage(frame(c.cellId, 'org.purged', { orgId, purged: ['toolLayers'] }));
    return { hub, connect, purge, purged };
}

describe('org purge on the hub (cell leg)', () => {
    it('asks every connected cell that names toolLayers, and is pending until each says org.purged', async () => {
        const t = setup();
        const a = await t.connect('cell-a', ['toolLayers']);
        const b = await t.connect('cell-b', ['toolLayers']);
        const status = await t.purge('org-1', [[a, 'ack'], [b, 'ack']]);
        expect(a.sock.all('org.purge')[0].body).toEqual({ orgId: 'org-1' });
        expect(status).toEqual({ cells: 2, purged: 0, pending: 2 });

        await t.purged(a, 'org-1');
        expect(await t.purge('org-1', [[b, 'ack']])).toEqual({ cells: 2, purged: 1, pending: 1 });
        await t.purged(b, 'org-1');
        expect(await t.purge('org-1', [])).toEqual({ cells: 2, purged: 2, pending: 0 });
    });

    it('is idempotent: a cell that acknowledged is not asked again, a pending one is', async () => {
        const t = setup();
        const a = await t.connect('cell-a', ['toolLayers']);
        const b = await t.connect('cell-b', ['toolLayers']);
        await t.purge('org-1', [[a, 'ack'], [b, 'ack']]);
        await t.purged(a, 'org-1');
        await t.purge('org-1', [[b, 'ack']]);
        expect(a.sock.all('org.purge')).toHaveLength(1);
        expect(b.sock.all('org.purge')).toHaveLength(2);
    });

    it('sends nothing to a cell that does not name toolLayers: it keeps no data of the org at rest', async () => {
        const t = setup();
        const old = await t.connect('cell-old', ['sandbox']);
        expect(await t.purge('org-1', [])).toEqual({ cells: 0, purged: 0, pending: 0 });
        expect(old.sock.all('org.purge')).toHaveLength(0);
    });

    it("sends nothing to another org's customer cell, but asks a Kodus one and the org's own", async () => {
        const t = setup();
        const other = await t.connect('cell-other', ['toolLayers'], { owner: 'customer', orgId: 'org-2' });
        const own = await t.connect('cell-own', ['toolLayers'], { owner: 'customer', orgId: 'org-1' });
        const shared = await t.connect('cell-shared', ['toolLayers']);
        const status = await t.purge('org-1', [[own, 'ack'], [shared, 'ack']]);
        expect(status.cells).toBe(2);
        expect(other.sock.all('org.purge')).toHaveLength(0);
    });

    it('keeps a cell pending when it refuses (a claim of the org is live on it) or does not answer, and asks again', async () => {
        const t = setup();
        const busy = await t.connect('cell-busy', ['toolLayers']);
        expect(await t.purge('org-1', [[busy, 'busy']])).toEqual({ cells: 1, purged: 0, pending: 1 });
        expect(await t.purge('org-1', [[busy, 'ack']])).toEqual({ cells: 1, purged: 0, pending: 1 });
        expect(busy.sock.all('org.purge')).toHaveLength(2);
    });

    it('keeps one org\'s acknowledgement from standing for another', async () => {
        const t = setup();
        const a = await t.connect('cell-a', ['toolLayers']);
        await t.purge('org-1', [[a, 'ack']]);
        await t.purged(a, 'org-1');
        expect(await t.purge('org-2', [[a, 'ack']])).toEqual({ cells: 1, purged: 0, pending: 1 });
    });

    it('refuses an org.purged nobody asked for, and counts nothing for it', async () => {
        const t = setup();
        const a = await t.connect('cell-a', ['toolLayers']);
        await t.purged(a, 'org-9');
        expect(a.sock.all('nack').at(-1)?.body.code).toBe('unknown_org_purge');
        expect(await t.purge('org-9', [[a, 'ack']])).toEqual({ cells: 1, purged: 0, pending: 1 });
    });
});
