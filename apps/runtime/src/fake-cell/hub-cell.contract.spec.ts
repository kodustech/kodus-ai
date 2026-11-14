import { InternalController } from '../hub/http/internal.controller';
import { HubClient } from '../worker/env/hub-environment-runtime';
import { HubPhysicalAdmissionClient } from '../worker/env/physical-admission-client';
import { EnvironmentRuntime } from '@libs/runtime/environment';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { shopRunRequest } from '../e2e/fixtures';
import { createCa } from '../hub/ca/x509';
import { CellHub, type CellHubOptions } from '../hub/cell-hub';
import { InMemoryHubStore } from '../hub/hub-store';
import { InMemoryAdmissionStore } from '../shared/admission/admission-store';
import type { PhysicalAdmissionTicket } from '../shared/admission/admission-contract';
import { PROTOCOL_VERSION } from '@libs/runtime/protocol';
import { randomUUID } from 'crypto';
import { AdmissionCoordinator } from '../worker/dbos/admission-coordinator';
import { inMemoryRunDeps } from '../worker/run/in-memory-deps';
import { runRuntimeRun } from '../worker/run/run-orchestrator';
import { FakeCell } from './fake-cell';
import { SCENARIOS } from './scenarios';

// Hub and fake cell talking the real protocol frames, in process: every frame
// in both directions goes through decodeFrame.

function wire(blockedHosts: string[] = [], admission?: CellHubOptions['admission']) {
    const store = new InMemoryHubStore();
    const streams = new InMemoryRunStreamStore();
    const hub = new CellHub(store, streams, new RuntimeMetrics(), {
        replicaId: 'r1',
        replicaUrl: 'http://hub',
        ca: createCa('contract CA'),
        log: () => undefined,
        ...(admission ? { admission } : {}),
    });
    let toHub: (f: string) => void = () => undefined;
    const cell = new FakeCell({ cellId: 'fake-cell', owner: 'kodus', scenarios: SCENARIOS, send: (f) => setImmediate(() => toHub(f)), blockedHosts });
    const handlers = hub.attach({ send: (f) => setImmediate(() => void cell.onFrame(f)), close: () => undefined }, { cellId: 'fake-cell', owner: 'kodus' });
    toHub = (f) => void handlers.onMessage(f);
    cell.hello();
    return { hub, store, streams, cell, handlers };
}

const viaHub = (hub: CellHub, req: ReturnType<typeof shopRunRequest>, admission?: PhysicalAdmissionTicket): EnvironmentRuntime => {
    const ref = (claimId: string) => ({ claimId, organizationId: req.organizationId, runId: req.runId });
    return {
    acquire: (a) => hub.acquire('fake-cell', { ...a, ...(admission ? { admission } : {}), expose: req.environment.expose, repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' }, repoToken: req.repoToken }),
    probe: (c, p, s) => hub.probe(ref(c), p, s),
    exec: (c, r) => hub.exec(ref(c), r),
    reset: async (c) => {
        const r = await hub.reset(ref(c), req.environment.imageId);
        if ('code' in r) return r;
    },
    release: (c) => hub.release(ref(c)),
    };
};

describe('hub ↔ fake cell contract', () => {
    it('redeems a pair, executes the real Run protocol and retains its permit until release is reconciled', async () => {
        const ownership = new InMemoryAdmissionStore();
        const directory = { reserve: jest.fn(), matches: async () => true, pin: async () => true, release: jest.fn(async () => undefined), retarget: async () => true };
        const { hub, handlers, cell, streams } = wire([], { ownership, directory });
        await new Promise((r) => setTimeout(r, 10));
        const heartbeat = () => handlers.onMessage(JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), cellId: 'fake-cell', type: 'heartbeat', body: {
            claims: [], freeSlots: 4, memory: { allocatableMb: 32_768, committedMb: 0, bootMb: 12_288, readyMb: 2_048 },
        } }));
        await heartbeat();
        const req = shopRunRequest();
        const limits = { globalWaiting: 10, perOrgWaiting: 10, globalExecuting: 2, perOrgExecuting: 2, maxAttempts: 3, leaseMs: 30_000, retryMs: 5000 };
        const accepted = await ownership.accept({ kind: 'run', request: req }, limits);
        if (!('record' in accepted)) throw new Error(accepted.status);
        const ref = { organizationId: req.organizationId, kind: 'run' as const, key: req.runId };
        const controller = new InternalController(hub);
        const responses: Array<{ status: number; body: unknown }> = [];
        // The actual controller/HTTP decoder boundary, with no listener or external network.
        const rpc = new HubClient({ cellDirectory: {} as any, hubBaseUrl: 'https://fixture', postImpl: async (_url, _headers, body) => {
            try {
                const out = await controller.admissionCancel('fake-cell', JSON.parse(body));
                responses.push({ status: 200, body: out });
                return { status: 200, text: JSON.stringify(out) };
            } catch (error) {
                const response = { status: error.getStatus(), body: error.getResponse() };
                responses.push(response);
                return { status: response.status, text: JSON.stringify(response.body) };
            }
        } });
        const physical = new HubPhysicalAdmissionClient({ post: rpc.post.bind(rpc), replicaForCell: async () => 'https://fixture' }, directory);
        const coordinator = new AdmissionCoordinator(ownership, {
            reserve: (request) => hub.tickets!.reserve('fake-cell', request),
            redeem: (ticket) => hub.tickets!.redeem(ticket),
            cancel: (ticket) => physical.cancel(ticket),
        }, limits);
        const wake = jest.fn(async (_id: string) => undefined);
        await coordinator.attempt(ref, accepted.record.generation, { step: async (_name, fn) => fn(), schedule: async () => { throw new Error('unexpected capacity retry'); }, wake });
        expect(wake).toHaveBeenCalledWith(req.runId);
        const decision = await coordinator.begin(ref, req.runId);
        if (decision.status !== 'ready') throw new Error(decision.reason);
        const { deps, projection } = inMemoryRunDeps({ env: viaHub(hub, req, decision.ticket) });
        await projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });
        expect(await runRuntimeRun(req, { ...deps, events: streams }, { noCapacityWait: true })).toMatchObject({ state: 'regression' });
        expect(cell.received.filter((type) => type === 'claim.acquire')).toHaveLength(2);
        expect(await coordinator.finish(ref, req.runId)).toEqual({ finished: false, cleanupFailed: false, cleanupPending: true });
        expect(responses[0]).toEqual({ status: 503, body: { code: 'member_cleanup_pending', message: 'member_cleanup_pending' } });
        expect(directory.release).not.toHaveBeenCalled();
        const concurrent = await Promise.all([coordinator.finish(ref, req.runId), coordinator.finish(ref, req.runId)]);
        expect(concurrent).toEqual(Array(2).fill({ finished: false, cleanupFailed: false, cleanupPending: true }));
        expect(cell.received.filter(type => type === 'claim.release')).toHaveLength(2);
        expect((await ownership.get(ref))!.permitHeld).toBe(true);
        await new Promise((r) => setTimeout(r, 2));
        await heartbeat();
        expect(await coordinator.finish(ref, req.runId)).toEqual({ finished: true, cleanupFailed: false });
        expect((await ownership.get(ref))!).toMatchObject({ state: 'completed', permitHeld: false, ticket: null });
        expect(directory.release).toHaveBeenCalledTimes(1);
        expect(responses.at(-1)).toEqual({ status: 200, body: { ok: true } });
        await handlers.onClose();
    });

    it('a Run through the hub and the fake cell reaches the regression verdict', async () => {
        const { hub, streams } = wire();
        await new Promise((r) => setTimeout(r, 10));
        const req = shopRunRequest();
        const env = viaHub(hub, req);
        const { deps, projection } = inMemoryRunDeps({ env });
        await projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });
        const result = await runRuntimeRun(req, { ...deps, events: streams });
        expect(result).toMatchObject({ state: 'regression', conclusion: 'failure' });
        const types = (await streams.read(req.organizationId, req.runId))!.events.map((e) => e.type);
        expect(types).toContain('step.started');
        expect(types).toContain('step.finished');
        expect(types[types.length - 1]).toBe('published');
    });

    it('egress blocked by the cell proxy reaches the verdict as neutral-forcing evidence', async () => {
        const { hub, store } = wire(['telemetry.example.test']);
        await new Promise((r) => setTimeout(r, 10));
        const req = shopRunRequest();
        const { deps, projection, claims } = inMemoryRunDeps({ env: viaHub(hub, req) });
        claims.egressBlocked = async (ids) => store.egress.filter((e) => ids.includes(e.claimId));
        await projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });
        const result = await runRuntimeRun(req, deps);
        expect(store.egress).toHaveLength(1);
        expect(result.title).toContain('1 blocked outbound request');
    });
});
