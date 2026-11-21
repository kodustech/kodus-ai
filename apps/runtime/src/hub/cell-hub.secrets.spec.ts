import { randomUUID } from 'crypto';

import { type ClaimSecret, decodeFrame, PROTOCOL_VERSION } from '@libs/runtime/protocol';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { createCa } from './ca/x509';
import { CellCredential, CellHub } from './cell-hub';
import type { OrgSecretRefs } from './claims/org-secret-refs';
import type { HubLogLine } from './hub-types';
import { InMemoryHubStore } from './testing';

// The org's secrets reach a claim by reference (docs/runtime/sandbox.md
// "Secrets: OpenBao"): id, name and hosts in claim.acquire and
// sandbox.acquire, to a cell that names the feature secrets, never to the PR
// side of a fork, to a sandbox only when its caller asked.

class FakeSocket {
    sent: any[] = [];
    send(d: string) {
        const r = decodeFrame(d);
        if ('code' in r) throw new Error(`hub sent an invalid frame: ${r.code} ${r.message}`);
        this.sent.push(r.message);
    }
    close() {}
    last(type: string) {
        return [...this.sent].reverse().find((m) => m.type === type);
    }
}

const frame = (type: string, body: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), cellId: 'cell-a', type, body, ...extra });
const CRED: CellCredential = { cellId: 'cell-a', owner: 'kodus' };
const CA = createCa('secrets spec CA');
const SHA = 'a'.repeat(40);
const tick = () => new Promise((r) => setImmediate(r));
const SECRETS: ClaimSecret[] = [{ id: 'npm_token', name: 'NPM_TOKEN', hosts: ['npm.corp.example'] }];

function setup(refs: OrgSecretRefs | undefined, features: string[]) {
    const logs: HubLogLine[] = [];
    const hub = new CellHub(new InMemoryHubStore(), new InMemoryRunStreamStore(), new RuntimeMetrics(), {
        replicaId: 'r1',
        replicaUrl: 'http://hub',
        ca: CA,
        log: (l) => logs.push(l),
        ...(refs ? { secrets: refs } : {}),
    });
    const connect = async () => {
        const sock = new FakeSocket();
        const h = hub.attach(sock, CRED);
        await h.onMessage(frame('hello', { versions: [1], driver: 'docker-gvisor', isolation: 'sandboxed-container', regions: ['local'], owner: 'kodus', features }));
        return { sock, ...h };
    };
    /** The body the cell got for one claim, which it then answers ready. */
    const sent = async (start: () => Promise<unknown>, type: 'claim.acquire' | 'sandbox.acquire') => {
        const c = await connect();
        const p = start();
        await tick();
        await tick();
        const req = c.sock.last(type);
        await c.onMessage(frame('ack', {}, { re: req.id }));
        await c.onMessage(frame('claim.ready', { manifest: { services: [], expose: [], imageId: 'img-1', seedSha: 'none' }, observer: { id: 'obs-1', state: 'ready' } }, { claimId: req.claimId }));
        await p;
        return req.body;
    };
    const run = (side: 'base' | 'pr' | 'setup', forkPullRequest = false) =>
        sent(
            () =>
                hub.acquire('cell-a', {
                    organizationId: 'org-a',
                    environmentId: 'shop',
                    imageId: 'img-1',
                    ref: { side, sha: SHA },
                    consumer: side === 'setup' ? 'setup' : 'runtime',
                    idempotencyKey: `k-${side}-${forkPullRequest}`,
                    expose: [],
                    repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
                    repoToken: 'tok',
                    ...(forkPullRequest ? { forkPullRequest: true } : {}),
                }),
            'claim.acquire',
        );
    const preview = (side: 'base' | 'pr', opts: { previewSecrets?: boolean; forkPullRequest?: boolean } = {}) =>
        sent(
            () =>
                hub.acquire('cell-a', {
                    organizationId: 'org-a',
                    environmentId: 'shop',
                    imageId: 'img-1',
                    ref: { side, sha: SHA },
                    consumer: 'preview',
                    idempotencyKey: `preview-${side}-${randomUUID()}`,
                    expose: [],
                    repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
                    repoToken: 'tok',
                    ...opts,
                }),
            'claim.acquire',
        );
    const sandbox = (secrets?: boolean) =>
        sent(() => hub.acquireSandbox('cell-a', { organizationId: 'org-a', idempotencyKey: `sandbox:${randomUUID()}`, ...(secrets ? { secrets } : {}) }), 'sandbox.acquire');
    return { run, preview, sandbox, logs };
}

const refs = (secrets: ClaimSecret[] = SECRETS): OrgSecretRefs & { asked: string[] } => {
    const asked: string[] = [];
    return { asked, secretsOf: async (org) => (asked.push(org), secrets) };
};

describe("the org's secrets on a claim", () => {
    it('a setup, a base and a PR of the repository itself get them by reference', async () => {
        const r = refs();
        const ctx = setup(r, ['secrets']);
        for (const side of ['setup', 'base', 'pr'] as const) expect((await ctx.run(side)).secrets).toEqual(SECRETS);
        expect(r.asked).toEqual(['org-a', 'org-a', 'org-a']);
    });

    it("the PR side of a fork gets none: its code is nobody's in the org", async () => {
        const ctx = setup(refs(), ['secrets']);
        expect(await ctx.run('pr', true)).not.toHaveProperty('secrets');
        expect((await ctx.run('base', true)).secrets).toEqual(SECRETS);
    });

    it('a preview gets them only when its environment is set to "same as the Run", and never on the PR side of a fork', async () => {
        const ctx = setup(refs(), ['secrets', 'preview']);
        expect(await ctx.preview('pr')).not.toHaveProperty('secrets');
        expect((await ctx.preview('pr', { previewSecrets: true })).secrets).toEqual(SECRETS);
        expect(await ctx.preview('pr', { previewSecrets: true, forkPullRequest: true })).not.toHaveProperty('secrets');
    });

    it('a cell that does not name the feature gets none (its decoder would refuse the field)', async () => {
        const ctx = setup(refs(), []);
        expect(await ctx.run('base')).not.toHaveProperty('secrets');
    });

    it('a sandbox gets them only when its caller asked', async () => {
        const ctx = setup(refs(), ['sandbox', 'secrets']);
        expect(await ctx.sandbox()).not.toHaveProperty('secrets');
        expect((await ctx.sandbox(true)).secrets).toEqual(SECRETS);
    });

    it('unreadable, the claim starts without them and the failure is logged', async () => {
        const ctx = setup({ secretsOf: async () => Promise.reject(new Error('connection refused')) }, ['secrets']);
        expect(await ctx.run('base')).not.toHaveProperty('secrets');
        expect(ctx.logs).toContainEqual(expect.objectContaining({ level: 'error', msg: 'claim.secrets.unread' }));
    });
});
