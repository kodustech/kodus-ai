import { randomUUID } from 'crypto';

import { decodeFrame, PROTOCOL_VERSION, SANDBOX_ENVIRONMENT_ID } from '@libs/runtime/protocol';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { createCa } from './ca/x509';
import { CellCredential, CellHub } from './cell-hub';
import { claimIdFor } from './claims/claim.service';
import { InMemoryHubStore } from './testing';

// The hub's side of a code sandbox (docs/runtime/sandbox.md): sandbox.acquire
// only to a cell that names sandbox, with the hosts approved for sandboxes and
// the caller's; sandbox.op only on a sandbox claim, each one audited per org.

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

const frame = (cellId: string, type: string, body: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), cellId, type, body, ...extra });
const CRED: CellCredential = { cellId: 'cell-a', owner: 'kodus' };
const CA = createCa('sandbox spec CA');
const tick = () => new Promise((r) => setImmediate(r));
const readyBody = { manifest: { services: [], expose: [], imageId: 'sandbox', seedSha: 'none' }, observer: { id: 'kodus-sbx-workload', state: 'ready' } };

function setup() {
    const store = new InMemoryHubStore();
    const hub = new CellHub(store, new InMemoryRunStreamStore(), new RuntimeMetrics(), { replicaId: 'r1', replicaUrl: 'http://hub', ca: CA, log: () => undefined });
    /** extra: more hello fields (capabilities, maxClaimSize). */
    const connect = async (features: string[], extra: Record<string, unknown> = {}) => {
        const sock = new FakeSocket();
        const h = hub.attach(sock, CRED);
        await h.onMessage(frame('cell-a', 'hello', { versions: [1], driver: 'docker-gvisor', isolation: 'sandboxed-container', regions: ['local'], owner: 'kodus', features, ...extra }));
        return { sock, ...h };
    };
    /** A sandbox the cell acks and reports ready. */
    const sandbox = async (c: Awaited<ReturnType<typeof connect>>, key: string, org = 'org-a') => {
        const p = hub.acquireSandbox('cell-a', { organizationId: org, idempotencyKey: key, egressAllow: ['github.com'] });
        await tick();
        await tick();
        const req = c.sock.last('sandbox.acquire');
        if (req && req.claimId === claimIdFor(org, key)) {
            await c.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
            await c.onMessage(frame('cell-a', 'claim.ready', readyBody, { claimId: req.claimId }));
        }
        return { claim: (await p) as any, req };
    };
    return { hub, store, connect, sandbox };
}

// the dev cell (2026-11-12): 14735 MB allocatable, a Run claim at -gvisor-mem-limit 12g, ready at 2g.
const devCellMemory = (committedMb: number) => ({ allocatableMb: 14_735, committedMb, bootMb: 12_288, readyMb: 2_048 });
const gvisorCapabilities = { backends: ['gvisor'], snapshotMemory: false, nestedDocker: true, kvm: false, arch: 'arm64' };

describe('code sandbox on the hub', () => {
    it('a sandbox opened with no size reserves the sandbox default, not the Run size', async () => {
        const ctx = setup();
        const c = await ctx.connect(['sandbox'], { capabilities: { ...gvisorCapabilities, sandboxSize: { memoryMb: 2_048, cpus: 2 } } });
        // The open that the dev cell refused: 10639 MB free right after a release, the claim asked 12288.
        await c.onMessage(frame('cell-a', 'heartbeat', { claims: [], freeSlots: 4, memory: devCellMemory(4_096) }));
        const { claim } = await ctx.sandbox(c, 'sandbox:s1');
        expect(claim).toMatchObject({ claimId: claimIdFor('org-a', 'sandbox:s1'), cellId: 'cell-a' });
        expect((await ctx.store.claim(claim.claimId))?.metering).toEqual({ driver: 'docker-gvisor', bootMb: 2_048, readyMb: 2_048, allocatableMb: 14_735, cpus: 2 });
    });

    it("a cell that names no sandbox size has the sandbox admitted at the hub's, and one that asks a size at it", async () => {
        const ctx = setup();
        const c = await ctx.connect(['sandbox']);
        await c.onMessage(frame('cell-a', 'heartbeat', { claims: [], freeSlots: 4, memory: devCellMemory(4_096) }));
        const { claim } = await ctx.sandbox(c, 'sandbox:s1');
        expect((await ctx.store.claim(claim.claimId))?.metering).toMatchObject({ bootMb: 2_048, readyMb: 2_048 });

        const sized = setup();
        const s = await sized.connect(['sandbox', 'claimSize'], { maxClaimSize: { memoryMb: 12_288, cpus: 4 }, capabilities: { ...gvisorCapabilities, sandboxSize: { memoryMb: 2_048, cpus: 2 } } });
        await s.onMessage(frame('cell-a', 'heartbeat', { claims: [], freeSlots: 4, memory: devCellMemory(0) }));
        const p = sized.hub.acquireSandbox('cell-a', { organizationId: 'org-a', idempotencyKey: 'sandbox:big', size: { memoryMb: 8_192, cpus: 4 } });
        await tick();
        await tick();
        const req = s.sock.last('sandbox.acquire');
        expect(req.body.size).toEqual({ memoryMb: 8_192, cpus: 4 });
        await s.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
        await s.onMessage(frame('cell-a', 'claim.ready', readyBody, { claimId: req.claimId }));
        await p;
        expect((await sized.store.claim(req.claimId))?.metering).toMatchObject({ bootMb: 8_192, readyMb: 8_192, cpus: 4 });
    });

    // G5 (docs/runtime/egress-allowlist.md §8, S-54): a sandbox used to get every host approved for any
    // environment of the org; an approval for one environment's setup reached every agent session.
    it("a cell that names sandbox gets sandbox.acquire with the caller's hosts and the sandbox's own approvals, never another environment's", async () => {
        const ctx = setup();
        ctx.store.approvals.set('org-a/env-1', ['registry.acme.dev']);
        ctx.store.approvals.set(`org-a/${SANDBOX_ENVIRONMENT_ID}`, ['docs.acme.dev']);
        ctx.store.approvals.set('org-b/env-9', ['other.org.dev']);
        const c = await ctx.connect(['egressAllow', 'sandbox']);
        const { claim, req } = await ctx.sandbox(c, 'sandbox:s1');
        expect(req.body).toEqual({ orgId: 'org-a', hardExpiresAt: expect.any(String), leaseExpiresAt: expect.any(String), egressAllow: ['docs.acme.dev', 'github.com'] });
        expect(claim).toMatchObject({ claimId: claimIdFor('org-a', 'sandbox:s1'), cellId: 'cell-a' });
        expect((await ctx.store.claim(claim.claimId))?.consumer).toBe('sandbox');
    });

    it('a cell that does not name sandbox gets nothing, and the claim is blocked before anything is recorded', async () => {
        const ctx = setup();
        const c = await ctx.connect(['egressAllow']);
        const { claim, req } = await ctx.sandbox(c, 'sandbox:s1');
        expect(req).toBeUndefined();
        expect(claim).toMatchObject({ status: 'blocked', blockers: [{ signature: 'sandbox_unsupported' }] });
        expect(await ctx.store.claim(claimIdFor('org-a', 'sandbox:s1'))).toBeNull();
    });

    it("an op runs on the org's own sandbox and is audited without its env or output", async () => {
        const ctx = setup();
        const c = await ctx.connect(['sandbox']);
        const { claim } = await ctx.sandbox(c, 'sandbox:s1');
        const stepId = randomUUID();
        const p = ctx.hub.sandboxOp({ claimId: claim.claimId, organizationId: 'org-a', runId: null }, stepId, {
            op: 'exec',
            command: 'git fetch https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/app',
            timeoutMs: 5_000,
            env: { GIT_AUTH_HEADER: 'Authorization: Basic not-a-real-header' },
        });
        await tick();
        await tick();
        const op = c.sock.last('sandbox.op');
        expect(op.body).toMatchObject({ stepId, op: { op: 'exec', env: { GIT_AUTH_HEADER: expect.any(String) } } });
        await c.onMessage(frame('cell-a', 'ack', {}, { re: op.id }));
        await c.onMessage(
            frame('cell-a', 'step.result', { stepId, executor: 'vm', imageId: 'sandbox', vmHealth: 'ok', sandbox: { ok: true, exec: { exitCode: 0, stdout: 'secret output', stderr: '', truncated: false, timedOut: false, durationMs: 3 } } }, { claimId: claim.claimId }),
        );
        expect(await p).toMatchObject({ ok: true, exec: { exitCode: 0 } });
        expect(ctx.store.sandboxAudit).toEqual([expect.objectContaining({ orgId: 'org-a', claimId: claim.claimId, stepId, op: 'exec', outcome: 'ok', exitCode: 0 })]);
        const audit = JSON.stringify(ctx.store.sandboxAudit);
        expect(audit).not.toContain('ghs_abcdefghijklmnopqrstuvwxyz0123456789');
        expect(audit).not.toContain('not-a-real-header');
        expect(audit).not.toContain('secret output');
    });

    it("another org's call never reaches a sandbox, and an op never runs on a claim that is not a sandbox", async () => {
        const ctx = setup();
        const c = await ctx.connect(['sandbox']);
        const { claim } = await ctx.sandbox(c, 'sandbox:s1');
        await expect(ctx.hub.sandboxOp({ claimId: claim.claimId, organizationId: 'org-b', runId: null }, randomUUID(), { op: 'stat' })).rejects.toThrow('not this tenant');
        await ctx.store.insertClaim({ claimId: 'run-claim', cellId: 'cell-a', orgId: 'org-a', side: 'pr', state: 'bound', consumer: 'runtime', hardExpiresAt: new Date(Date.now() + 60_000).toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } as any);
        expect(await ctx.hub.sandboxOp({ claimId: 'run-claim', organizationId: 'org-a', runId: null }, randomUUID(), { op: 'stat' })).toEqual({ code: 'workload_exec_unavailable' });
        expect(c.sock.sent.filter((m) => m.type === 'sandbox.op')).toHaveLength(0);
    });

    describe('sealing the sandbox egress', () => {
        const ref = (claimId: string, organizationId = 'org-a') => ({ claimId, organizationId, runId: null });

        it('sends an egress.policy that seals only that claim, and resolves once the cell acks it', async () => {
            const ctx = setup();
            const c = await ctx.connect(['sandbox']);
            const { claim } = await ctx.sandbox(c, 'sandbox:s1');
            const p = ctx.hub.sealSandboxEgress(ref(claim.claimId));
            await tick();
            await tick();
            const sent = c.sock.last('egress.policy');
            expect(sent).toMatchObject({ claimId: claim.claimId, body: { allow: [], sealed: true } });
            await c.onMessage(frame('cell-a', 'ack', {}, { re: sent.id }));
            expect(await p).toEqual({ sealed: true });
        });

        it('is not sealed when the cell refuses it: the caller gets an error, never a success', async () => {
            const ctx = setup();
            const c = await ctx.connect(['sandbox']);
            const { claim } = await ctx.sandbox(c, 'sandbox:s1');
            const p = ctx.hub.sealSandboxEgress(ref(claim.claimId));
            await tick();
            await tick();
            const sent = c.sock.last('egress.policy');
            await c.onMessage(frame('cell-a', 'nack', { code: 'seal_failed', message: 'the sealed policy was not pushed' }, { re: sent.id }));
            expect(await p).toMatchObject({ code: 'cell_unavailable' });
        });

        it("never seals another org's sandbox, nor a claim that is not a sandbox, nor one that ended", async () => {
            const ctx = setup();
            const c = await ctx.connect(['sandbox']);
            const { claim } = await ctx.sandbox(c, 'sandbox:s1');
            await expect(ctx.hub.sealSandboxEgress(ref(claim.claimId, 'org-b'))).rejects.toThrow('not this tenant');
            await ctx.store.insertClaim({ claimId: 'run-claim', cellId: 'cell-a', orgId: 'org-a', side: 'pr', state: 'bound', consumer: 'runtime', hardExpiresAt: new Date(Date.now() + 60_000).toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } as any);
            expect(await ctx.hub.sealSandboxEgress(ref('run-claim'))).toEqual({ code: 'workload_exec_unavailable' });
            expect(await ctx.hub.sealSandboxEgress(ref(claimIdFor('org-a', 'sandbox:none')))).toEqual({ code: 'lease_expired' });
            expect(c.sock.sent.filter((m) => m.type === 'egress.policy')).toHaveLength(0);
        });
    });

    describe('memory snapshots (feature snapshots)', () => {
        const sid = 'ksn-0123456789abcdef0123456789abcdef';
        const fcCapabilities = { backends: ['firecracker'], snapshotMemory: true, nestedDocker: true, kvm: true, arch: 'x86_64' };

        it('a sandbox that prepares a template or resumes a session goes only to a cell that keeps snapshots; a template key is dropped for any other', async () => {
            const ctx = setup();
            const c = await ctx.connect(['sandbox'], { capabilities: gvisorCapabilities });
            await c.onMessage(frame('cell-a', 'heartbeat', { claims: [], freeSlots: 4 }));
            for (const req of [{ prepares: true, templateKey: 'repo:a' }, { resumeFrom: sid }]) {
                const out = await ctx.hub.acquireSandbox('cell-a', { organizationId: 'org-a', idempotencyKey: `sandbox:${randomUUID()}`, ...req });
                expect(out).toMatchObject({ status: 'blocked', blockers: [{ signature: 'snapshot_unsupported' }] });
            }
            expect(c.sock.last('sandbox.acquire')).toBeUndefined();
            const p = ctx.hub.acquireSandbox('cell-a', { organizationId: 'org-a', idempotencyKey: 'sandbox:k', templateKey: 'repo:a' });
            await tick();
            await tick();
            expect(c.sock.last('sandbox.acquire').body).not.toHaveProperty('templateKey');
            void p.catch(() => undefined);
        });

        it('to a cell that keeps them, the fields go with sandbox.acquire, claim.snapshot answers with the snapshot and a reset names its round', async () => {
            const ctx = setup();
            const c = await ctx.connect(['sandbox', 'snapshots'], { capabilities: fcCapabilities });
            await c.onMessage(frame('cell-a', 'heartbeat', { claims: [], freeSlots: 4 }));
            const p = ctx.hub.acquireSandbox('cell-a', { organizationId: 'org-a', idempotencyKey: 'sandbox:tpl', prepares: true, templateKey: 'repo:a' });
            await tick();
            await tick();
            const req = c.sock.last('sandbox.acquire');
            expect(req.body).toMatchObject({ prepares: true, templateKey: 'repo:a' });
            await c.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
            await c.onMessage(frame('cell-a', 'claim.ready', { ...readyBody, start: 'cold' }, { claimId: req.claimId }));
            const claim = (await p) as any;
            const ref = { claimId: claim.claimId, organizationId: 'org-a', runId: null };

            const stepId = randomUUID();
            const snap = ctx.hub.snapshot(ref, stepId, 'round');
            await tick();
            await tick();
            const asked = c.sock.last('claim.snapshot');
            expect(asked.body).toEqual({ stepId, purpose: 'round' });
            await c.onMessage(frame('cell-a', 'ack', {}, { re: asked.id }));
            await c.onMessage(frame('cell-a', 'step.result', { stepId, executor: 'vm', imageId: 'sandbox', vmHealth: 'ok', snapshot: { id: sid, purpose: 'round', ms: 900 } }, { claimId: claim.claimId }));
            // With the cell that holds it: a snapshot never leaves it.
            expect(await snap).toEqual({ id: sid, purpose: 'round', ms: 900, cellId: 'cell-a' });

            const resetStep = randomUUID();
            const reset = ctx.hub.reset(ref, 'sandbox', resetStep, sid);
            await tick();
            await tick();
            const r = c.sock.last('machine.reset');
            expect(r.body).toEqual({ stepId: resetStep, snapshot: { kind: 'memory', ref: sid } });
            await c.onMessage(frame('cell-a', 'ack', {}, { re: r.id }));
            await c.onMessage(frame('cell-a', 'step.result', { stepId: resetStep, executor: 'vm', imageId: 'sandbox', vmHealth: 'ok', durationMs: 120 }, { claimId: claim.claimId }));
            expect(await reset).toEqual({ ok: true, durationMs: 120 });

            // A result without the snapshot it was asked for is no snapshot.
            const lost = randomUUID();
            const bad = ctx.hub.snapshot(ref, lost, 'session');
            await tick();
            await tick();
            await c.onMessage(frame('cell-a', 'ack', {}, { re: c.sock.last('claim.snapshot').id }));
            await c.onMessage(frame('cell-a', 'step.result', { stepId: lost, executor: 'vm', imageId: 'sandbox', vmHealth: 'unreachable' }, { claimId: claim.claimId }));
            expect(await bad).toEqual({ code: 'transport_lost', stepId: lost });
        });
    });
});
