import { randomUUID } from 'crypto';

import { decodeFrame, PROTOCOL_VERSION } from '@libs/runtime/protocol';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { createCa } from './ca/x509';
import { CellCredential, CellHub, HubLogLine } from './cell-hub';
import { claimIdFor } from './claims/claim.service';
import { InternalController } from './http/internal.controller';
import { InMemoryHubStore } from './testing';

// claim.acquire repos (the other repositories of a multi-repository
// environment) reach only a cell whose hello names workspace; a cell that
// does not gets the other_repo blocker naming each repository, before
// anything is recorded or sent. Their tokens never reach a log line.

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

const SHA = 'a'.repeat(40);
const MEMBER_SHA = 'c'.repeat(40);
const frame = (cellId: string, type: string, body: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), cellId, type, body, ...extra });
const CRED: Record<string, CellCredential> = { 'cell-a': { cellId: 'cell-a', owner: 'kodus' } };
const CA = createCa('workspace spec CA');
const manifest = { services: [{ name: 'web', health: 'ok' }], expose: [{ service: 'web', port: 3000, kind: 'http' }], imageId: 'img-1', seedSha: 'seed-1' };
const tick = () => new Promise((r) => setImmediate(r));
const FEATURES = ['seedsCache', 'claimSize', 'egressAllow', 'poolMachineSize', 'authoredFiles'];

const repos = [
    { alias: 'billing', repo: { provider: 'github' as const, fullName: 'acme/billing', apiBase: 'https://api.github.com' }, sha: MEMBER_SHA, repoToken: 'ghs_member_token_billing' },
    { alias: 'ledger', repo: { provider: 'github' as const, fullName: 'acme/ledger', apiBase: 'https://api.github.com' }, sha: MEMBER_SHA, repoToken: 'ghs_member_token_ledger' },
];

function setup() {
    const store = new InMemoryHubStore();
    const logs: HubLogLine[] = [];
    const hub = new CellHub(store, new InMemoryRunStreamStore(), new RuntimeMetrics(), { replicaId: 'r1', replicaUrl: 'http://hub', ca: CA, log: (l) => void logs.push(l) });
    const connect = async (features: string[]) => {
        const sock = new FakeSocket();
        const h = hub.attach(sock, CRED['cell-a']);
        await h.onMessage(frame('cell-a', 'hello', { versions: [1], driver: 'fake', isolation: 'vm', regions: ['local'], owner: 'kodus', features }));
        return { sock, ...h };
    };
    /** A setup claim with `repos`; answered ready when the hub sent claim.acquire, failed with `failure` when given. */
    const acquire = async (c: Awaited<ReturnType<typeof connect>>, key: string, over: Record<string, unknown> = {}, failure?: string) => {
        const before = c.sock.sent.filter((m) => m.type === 'claim.acquire').length;
        const p = hub.acquire('cell-a', {
            organizationId: 'org-a',
            environmentId: 'shop',
            imageId: 'setup',
            ref: { side: 'setup', sha: SHA },
            consumer: 'setup',
            idempotencyKey: key,
            expose: [{ service: 'web', port: 3000, kind: 'http' }],
            repo: { provider: 'github', fullName: 'acme/app', apiBase: 'https://api.github.com' },
            repoToken: 'ghs_primary_token_app',
            repos,
            ...over,
        });
        await tick();
        await tick();
        const sent = c.sock.sent.filter((m) => m.type === 'claim.acquire');
        const req = sent.length > before ? sent[sent.length - 1] : undefined;
        if (req) {
            await c.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
            if (failure) await c.onMessage(frame('cell-a', 'claim.failed', { kind: 'toolchain', signature: 'fetch', reason: failure }, { claimId: req.claimId }));
            else await c.onMessage(frame('cell-a', 'claim.ready', { manifest, observer: { id: 'obs-1', state: 'ready' } }, { claimId: req.claimId }));
        }
        return { claim: (await p) as any, req };
    };
    return { hub, store, logs, connect, acquire };
}

describe('claim.acquire repos', () => {
    it('a cell without workspace gets the other_repo blocker naming each repository; nothing is recorded or sent', async () => {
        const ctx = setup();
        const c = await ctx.connect(FEATURES);
        const { claim, req } = await ctx.acquire(c, 'setup:old');
        expect(req).toBeUndefined();
        expect(claim).toEqual({
            status: 'blocked',
            blockers: [
                { kind: 'other_repo', signature: 'recipe_needs', message: expect.stringContaining('billing cannot boot'), alias: 'billing' },
                { kind: 'other_repo', signature: 'recipe_needs', message: expect.stringContaining('ledger cannot boot'), alias: 'ledger' },
            ],
        });
        expect(await ctx.store.claim(claimIdFor('org-a', 'setup:old'))).toBeNull();
        expect(ctx.logs.find((l) => l.msg === 'claim.workspace_unsupported')).toMatchObject({ cellId: 'cell-a', repos: ['billing', 'ledger'] });
        expect(JSON.stringify(ctx.logs)).not.toContain('ghs_member_token');
        // The same cell still takes the claim of one repository, with no repos field.
        const one = await ctx.acquire(c, 'setup:one', { repos: undefined });
        expect(one.req.body).not.toHaveProperty('repos');
        expect(one.claim).toMatchObject({ claimId: one.req.claimId });
    });

    it('a cell that names workspace gets every repository with its own commit and token, and the logs name them by alias only', async () => {
        const ctx = setup();
        const c = await ctx.connect([...FEATURES, 'workspace']);
        const { claim, req } = await ctx.acquire(c, 'setup:new');
        expect(req.body).toMatchObject({ repo: { fullName: 'acme/app' }, repoToken: 'ghs_primary_token_app', sha: SHA, repos });
        expect(claim).toMatchObject({ claimId: req.claimId });
        expect(ctx.logs.find((l) => l.msg === 'claim.acquire')).toMatchObject({ repos: [`billing@${MEMBER_SHA.slice(0, 12)}`, `ledger@${MEMBER_SHA.slice(0, 12)}`] });
        expect(JSON.stringify(ctx.logs)).not.toContain('ghs_');
    });

    it("a failure the cell reports with a repository's token in it never hands the token back or records it", async () => {
        const ctx = setup();
        const c = await ctx.connect([...FEATURES, 'workspace']);
        const { claim } = await ctx.acquire(c, 'setup:leak', {}, 'git fetch https://x-access-token:ghs_member_token_billing@github.com/acme/billing failed');
        expect(claim.status).toBe('blocked');
        expect(claim.blockers[0].message).not.toContain('ghs_member_token_billing');
        expect(claim.blockers[0].message).toContain('[redacted');
        const rows = await ctx.store.claimBlockers([claimIdFor('org-a', 'setup:leak')]);
        expect(JSON.stringify(rows)).not.toContain('ghs_member_token_billing');
    });

    it("a member repository's failure, named at the start of the cell's reason, puts its alias on the blocker", async () => {
        const ctx = setup();
        const c = await ctx.connect([...FEATURES, 'workspace']);
        const member = await ctx.acquire(c, 'setup:member', {}, 'repository billing: the tarball fetch answered 404');
        expect(member.claim.blockers[0]).toMatchObject({ kind: 'toolchain', signature: 'fetch', alias: 'billing' });
        const own = await ctx.acquire(c, 'setup:own', {}, 'compose up failed');
        expect(own.claim.blockers[0]).not.toHaveProperty('alias');
    });

    it('image.bake carries refsDigest to a cell that names workspace, and is refused for one that does not', async () => {
        const digest = `sha256:${'f'.repeat(64)}`;
        for (const [features, expected] of [
            [[...FEATURES, 'workspace'], 'sent'],
            [FEATURES, 'refused'],
        ] as const) {
            const ctx = setup();
            const c = await ctx.connect([...features]);
            const { claim } = await ctx.acquire(c, `setup:bake:${expected}`, { repos: undefined });
            const p = ctx.hub.bake({ organizationId: 'org-a', environmentId: 'shop', recipeSha: SHA, sha: SHA, claimId: claim.claimId, refsDigest: digest });
            await tick();
            await tick();
            const sent = c.sock.last('image.bake');
            if (expected === 'sent') {
                expect(sent.body).toEqual({ orgId: 'org-a', environmentId: 'shop', recipeSha: SHA, sha: SHA, refsDigest: digest });
                await c.onMessage(frame('cell-a', 'ack', {}, { re: sent.id }));
                expect(await p).toEqual({ status: 'accepted' });
            } else {
                expect(sent).toBeUndefined();
                expect(await p).toMatchObject({ status: 'refused', code: 'workspace_unsupported' });
            }
        }
    });

    it('a bake of one repository is sent as before, without refsDigest', async () => {
        const ctx = setup();
        const c = await ctx.connect(FEATURES);
        const { claim } = await ctx.acquire(c, 'setup:plain', { repos: undefined });
        const p = ctx.hub.bake({ organizationId: 'org-a', environmentId: 'shop', recipeSha: SHA, sha: SHA, claimId: claim.claimId });
        await tick();
        await tick();
        const sent = c.sock.last('image.bake');
        expect(sent.body).toEqual({ orgId: 'org-a', environmentId: 'shop', recipeSha: SHA, sha: SHA });
        await c.onMessage(frame('cell-a', 'ack', {}, { re: sent.id }));
        await p;
    });
});

describe('the internal routes of a multi-repository claim', () => {
    const status = async (p: Promise<unknown>) => p.then(() => 200, (e: { getStatus?: () => number }) => e.getStatus?.() ?? 500);
    const body = {
        organizationId: 'org-a',
        environmentId: 'env-1',
        ref: { side: 'setup', sha: SHA },
        consumer: 'setup',
        idempotencyKey: 'setup:1',
        expose: [],
        repo: { provider: 'github', fullName: 'acme/app', apiBase: 'https://api.github.com' },
        repoToken: 'tok',
    };

    it('the acquire takes repos and refuses an alias twice, a bad alias or an empty list', async () => {
        const seen: any[] = [];
        const c = new InternalController({ acquire: async (_cell: string, req: unknown) => (seen.push(req), { status: 'blocked', blockers: [] }) } as any);
        await c.acquire('cell-a', { ...body, repos });
        expect(seen[0].repos).toEqual(repos);
        expect(await status(c.acquire('cell-a', { ...body, repos: [repos[0], { ...repos[1], alias: 'billing' }] }))).toBe(400);
        expect(await status(c.acquire('cell-a', { ...body, repos: [{ ...repos[0], alias: '../billing' }] }))).toBe(400);
        expect(await status(c.acquire('cell-a', { ...body, repos: [] }))).toBe(400);
        expect(seen).toHaveLength(1);
    });

    it('the bake takes refsDigest and refuses a malformed one', async () => {
        const seen: unknown[] = [];
        const c = new InternalController({ bake: async (req: unknown) => (seen.push(req), { status: 'accepted' }) } as any);
        const bake = { organizationId: 'org-a', runId: null, environmentId: 'env-1', recipeSha: 'sha256:abc', sha: SHA };
        const refsDigest = `sha256:${'f'.repeat(64)}`;
        await c.bake('c1', { ...bake, refsDigest });
        expect(seen).toEqual([{ organizationId: 'org-a', environmentId: 'env-1', recipeSha: 'sha256:abc', sha: SHA, refsDigest, claimId: 'c1' }]);
        expect(await status(c.bake('c1', { ...bake, refsDigest: 'sha256:nope' }))).toBe(400);
    });
});

describe('exec.repository', () => {
    it('reaches a cell that names workspace, and never one that does not', async () => {
        for (const [features, sent] of [
            [[...FEATURES, 'workspace'], true],
            [FEATURES, false],
        ] as const) {
            const ctx = setup();
            const c = await ctx.connect([...features]);
            const { claim } = await ctx.acquire(c, `setup:exec:${sent}`, { repos: undefined });
            const stepId = randomUUID();
            const p = ctx.hub.exec({ claimId: claim.claimId, organizationId: 'org-a' }, { stepId, command: 'npm test', timeoutMs: 1_000, repository: 'billing' });
            for (let i = 0; i < 6; i++) await tick();
            const exec = c.sock.last('exec');
            if (sent) {
                expect(exec.body).toMatchObject({ stepId, command: 'npm test', repository: 'billing' });
                await c.onMessage(frame('cell-a', 'step.result', { stepId, executor: 'vm', imageId: 'img-1', vmHealth: 'ok', exec: { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1 } }, { claimId: claim.claimId, re: exec.id }));
                expect(await p).toMatchObject({ exitCode: 0 });
            } else {
                expect(exec).toBeUndefined();
                expect(await p).toEqual({ code: 'workload_exec_unavailable' });
            }
        }
    });

    it('the exec route takes an alias and refuses anything else', async () => {
        const seen: any[] = [];
        const c = new InternalController({ exec: async (_ref: unknown, req: unknown) => (seen.push(req), { exitCode: 0 }) } as any);
        const body = { organizationId: 'org-a', stepId: randomUUID(), command: 'npm test', timeoutMs: 1_000 };
        await c.exec('c1', { ...body, repository: 'billing' });
        await c.exec('c1', body);
        expect(seen[0].repository).toBe('billing');
        expect(seen[1]).not.toHaveProperty('repository');
        await expect(c.exec('c1', { ...body, repository: '../etc' })).rejects.toBeDefined();
    });
});

describe('exec.service', () => {
    it('reaches a cell that names execService, and never one that does not: the answer is exec_service_unavailable and nothing is sent', async () => {
        for (const [features, sent] of [
            [[...FEATURES, 'execService'], true],
            [FEATURES, false],
        ] as const) {
            const ctx = setup();
            const c = await ctx.connect([...features]);
            const { claim } = await ctx.acquire(c, `setup:execsvc:${sent}`, { repos: undefined });
            const stepId = randomUUID();
            const p = ctx.hub.exec({ claimId: claim.claimId, organizationId: 'org-a' }, { stepId, command: 'npx cypress run', timeoutMs: 1_000, service: 'e2e' });
            for (let i = 0; i < 6; i++) await tick();
            const exec = c.sock.last('exec');
            if (sent) {
                expect(exec.body).toMatchObject({ stepId, command: 'npx cypress run', service: 'e2e' });
                await c.onMessage(frame('cell-a', 'step.result', { stepId, executor: 'vm', imageId: 'img-1', vmHealth: 'ok', exec: { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1 } }, { claimId: claim.claimId, re: exec.id }));
                expect(await p).toMatchObject({ exitCode: 0 });
            } else {
                expect(exec).toBeUndefined();
                expect(await p).toEqual({ code: 'exec_service_unavailable' });
            }
        }
    });

    it('an exec with no service is sent to a cell that does not name the feature, as it always was', async () => {
        const ctx = setup();
        const c = await ctx.connect([...FEATURES]);
        const { claim } = await ctx.acquire(c, 'setup:execsvc:none', { repos: undefined });
        const stepId = randomUUID();
        void ctx.hub.exec({ claimId: claim.claimId, organizationId: 'org-a' }, { stepId, command: 'ls', timeoutMs: 1_000 });
        for (let i = 0; i < 6; i++) await tick();
        expect(c.sock.last('exec').body).not.toHaveProperty('service');
    });

    it('the exec route takes a service name and refuses anything else', async () => {
        const seen: any[] = [];
        const c = new InternalController({ exec: async (_ref: unknown, req: unknown) => (seen.push(req), { exitCode: 0 }) } as any);
        const body = { organizationId: 'org-a', stepId: randomUUID(), command: 'ls', timeoutMs: 1_000 };
        await c.exec('c1', { ...body, service: 'e2e' });
        await c.exec('c1', body);
        expect(seen[0].service).toBe('e2e');
        expect(seen[1]).not.toHaveProperty('service');
        await expect(c.exec('c1', { ...body, service: '../etc' })).rejects.toBeDefined();
    });
});
