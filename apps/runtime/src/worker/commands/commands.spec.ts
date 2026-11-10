import { InMemoryPrAdmissionStore } from '../../shared/pr-admission-store';
import { RUNTIME_CONTROL_BINDING, RUNTIME_CONTROL_ROUTING_KEY, RUNTIME_RUN_ROUTING_KEY, RuntimeEventName, runtimeEnvelope, runtimeOutboxMessage } from '@libs/runtime/run';
import { RuntimeCommandName, runtimeCommandOutboxMessage, runtimeCommandRoute } from '@libs/runtime/api/domain/runtime-commands';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';

import { shopRunRequest } from '../../e2e/fixtures';
import { InMemoryDistributedLocks } from '../../shared/locks';
import { InMemoryCommandStore } from '../../shared/pg-command-store';
import { RuntimeCommandConsumer } from '../consumer/run-request.consumer';
import { EnvironmentPoolRequestedHandler } from './command-handlers';
import { AmqpPublishRequester, PUBLISH_CONFIRM_TIMEOUT_MS } from '../publish/amqp-publish-requester';
import { inMemoryRunDeps } from '../run/in-memory-deps';
import { runRuntimeRun } from '../run/run-orchestrator';

const asMessage = (payload: unknown, event: string = RuntimeEventName.RunRequested) => runtimeEnvelope(event, { ...(payload as object), workflowType: 'RUNTIME_RUN' }, 'm1') as any;

function engine() {
    return {
        start: jest.fn(async (r: { runId: string }) => {
            // The engine's own latency: lets a concurrent message interleave if nothing serializes them.
            await new Promise((ok) => setTimeout(ok, 5));
            return r.runId;
        }),
        stop: jest.fn(async () => 'stop'),
        approve: jest.fn(async () => undefined),
        startSetup: jest.fn(async () => 'setup'),
    };
}

describe('RunRequested under concurrency', () => {
    it('two heads registered before effects: only the latest generation starts', async () => {
        const projection = new InMemoryRunProjectionStore();
        const e = engine();
        const consumer = new RuntimeCommandConsumer(e as any, projection, new InMemoryCommandStore(), new InMemoryPrAdmissionStore(), undefined, undefined, new InMemoryDistributedLocks());
        const a = shopRunRequest();
        const b = shopRunRequest({ pullRequest: { ...a.pullRequest, headSha: 'c'.repeat(40) } });
        await Promise.all([consumer.handle(asMessage(a)), consumer.handle(asMessage(b))]);
        expect(e.start).toHaveBeenCalledTimes(1);
        expect(e.start).toHaveBeenCalledWith(expect.objectContaining({ runId: b.runId }));
        expect((await projection.get(a.runId, { organizationId: a.organizationId }))?.state).toBe('superseded');
    });

    it('the same head delivered twice at once starts one Run', async () => {
        const projection = new InMemoryRunProjectionStore();
        const e = engine();
        const consumer = new RuntimeCommandConsumer(e as any, projection, new InMemoryCommandStore(), new InMemoryPrAdmissionStore(), undefined, undefined, new InMemoryDistributedLocks());
        const a = shopRunRequest();
        const again = shopRunRequest({ pullRequest: a.pullRequest });
        await Promise.all([consumer.handle(asMessage(a)), consumer.handle(asMessage(again))]);
        expect(e.start).toHaveBeenCalledTimes(1);
    });

    it('a setup store that cannot be read fails the message (retried), never boots with the request recipe', async () => {
        const e = engine();
        const setups = { get: async () => Promise.reject(new Error('mongo down')) };
        const consumer = new RuntimeCommandConsumer(e as any, new InMemoryRunProjectionStore(), new InMemoryCommandStore(), new InMemoryPrAdmissionStore(), undefined, setups);
        await expect(consumer.handle(asMessage(shopRunRequest()))).rejects.toThrow('mongo down');
        expect(e.start).not.toHaveBeenCalled();
    });

    it('a Run boots at the machine size its setup booted with, never at one the request names', async () => {
        const active = (machineSize?: { memoryMb: number; cpus: number }) => ({
            get: async () => ({
                environmentId: 'shop',
                organizationId: 'org-demo',
                repositoryId: 'repo-shop',
                key: 'k',
                state: 'active' as const,
                steps: [],
                blockers: [],
                requestedAt: '2026-11-05T10:00:00.000Z',
                updatedAt: '2026-11-05T10:00:00.000Z',
                ...(machineSize ? { machineSize } : {}),
            }),
        });
        const sized = engine();
        await new RuntimeCommandConsumer(sized as any, new InMemoryRunProjectionStore(), new InMemoryCommandStore(), new InMemoryPrAdmissionStore(), undefined, active({ memoryMb: 16_384, cpus: 8 })).handle(
            asMessage(shopRunRequest()),
        );
        expect((sized.start.mock.calls[0] as any[])[0].environment.size).toEqual({ memoryMb: 16_384, cpus: 8 });
        const plain = engine();
        const req = shopRunRequest();
        req.environment = { ...req.environment, size: { memoryMb: 65_536, cpus: 16 } };
        await new RuntimeCommandConsumer(plain as any, new InMemoryRunProjectionStore(), new InMemoryCommandStore(), new InMemoryPrAdmissionStore(), undefined, active()).handle(asMessage(req));
        expect((plain.start.mock.calls[0] as any[])[0].environment).not.toHaveProperty('size');
        // With no active setup (or no setup store) the request's size is not taken either: the cell's default.
        for (const setups of [{ get: async () => null }, undefined]) {
            const none = engine();
            await new RuntimeCommandConsumer(none as any, new InMemoryRunProjectionStore(), new InMemoryCommandStore(), new InMemoryPrAdmissionStore(), undefined, setups).handle(asMessage(req));
            expect((none.start.mock.calls[0] as any[])[0].environment).not.toHaveProperty('size');
        }
    });

    it("a Run waits on its setup's ready check, never on one the request names", async () => {
        const setup = {
            get: async () => ({
                environmentId: 'shop',
                organizationId: 'org-demo',
                repositoryId: 'repo-shop',
                key: 'k',
                state: 'active' as const,
                steps: [],
                blockers: [],
                expose: [{ service: 'web', port: 3000, kind: 'http' as const }],
                recipe: { path: '.kodus/workspace.yaml', sha: 'a'.repeat(40), state: 'found' as const, content: 'x', public: 'web', health: '/api/health', healthTimeoutSeconds: 90 },
                requestedAt: '2026-11-05T10:00:00.000Z',
                updatedAt: '2026-11-05T10:00:00.000Z',
            }),
        };
        const req = shopRunRequest();
        req.environment = { ...req.environment, ready: { service: 'evil', port: 1, path: '/x', waitSeconds: 900 } };
        const e = engine();
        await new RuntimeCommandConsumer(e as any, new InMemoryRunProjectionStore(), new InMemoryCommandStore(), new InMemoryPrAdmissionStore(), undefined, setup as any).handle(asMessage(req));
        expect((e.start.mock.calls[0] as any[])[0].environment.ready).toEqual({ service: 'web', port: 3000, path: '/api/health', waitSeconds: 90 });
        // Without an active setup the request's ready check is dropped too.
        const none = engine();
        await new RuntimeCommandConsumer(none as any, new InMemoryRunProjectionStore(), new InMemoryCommandStore(), new InMemoryPrAdmissionStore(), undefined, { get: async () => null }).handle(asMessage(req));
        expect((none.start.mock.calls[0] as any[])[0].environment).not.toHaveProperty('ready');
    });

    it('refuses a Run request whose tokens are not sealed', async () => {
        const e = engine();
        const consumer = new RuntimeCommandConsumer(e as any, new InMemoryRunProjectionStore(), new InMemoryCommandStore(), new InMemoryPrAdmissionStore());
        const out = await consumer.handle(asMessage({ ...shopRunRequest(), repoToken: 'ghs_plain' }));
        expect(out).toMatchObject({ requeue: false });
        expect(e.start).not.toHaveBeenCalled();
    });
});

describe('AmqpPublishRequester', () => {
    /** A real publication: the check a Run sends at its end. */
    async function realCheck() {
        const { deps, projection, published } = inMemoryRunDeps();
        const req = shopRunRequest();
        await projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });
        await runRuntimeRun(req, deps);
        return published.find((p) => p.kind === 'check' && !p.progress)!;
    }

    it('waits for the broker confirm, with a deadline, and fails the step when the broker refuses or times out', async () => {
        const msg = await realCheck();
        const publish = jest.fn(async (..._a: unknown[]) => true);
        await new AmqpPublishRequester({ publish } as any).request(msg);
        expect(publish.mock.calls[0][3]).toMatchObject({ persistent: true, messageId: msg.key, timeout: PUBLISH_CONFIRM_TIMEOUT_MS });
        await expect(new AmqpPublishRequester({ publish: async () => false } as any).request(msg)).rejects.toThrow(/broker refused/);
        await expect(new AmqpPublishRequester({ publish: async () => Promise.reject(new Error('confirm timeout')) } as any).request(msg)).rejects.toThrow(/confirm timeout/);
    });

    it('every check and comment a Run sends carries the structured report, never free text', async () => {
        const { deps, projection, published } = inMemoryRunDeps();
        const req = shopRunRequest();
        await projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });
        await runRuntimeRun(req, deps);
        for (const p of published.filter((x) => !x.progress)) {
            expect(p.report).toBeDefined();
            expect(p.comment).toBeUndefined();
        }
    });
});

describe('EnvironmentPoolRequested', () => {
    const body = (over: Record<string, unknown> = {}) => ({
        environmentId: 'env-1',
        organizationId: 'org-a',
        size: 2,
        requestedBy: { userId: 'u-1' },
        requestedAt: '2026-11-03T12:00:00.000Z',
        key: 'env-1:pool:2026-11-03T12:00:00.000Z',
        ...over,
    });
    const sender = () => {
        const sent: unknown[] = [];
        return { sent, pool: { send: async (r: unknown) => (sent.push(r), { status: 'accepted' as const }) } };
    };

    it("sends the size to the cell of the environment's last setup", async () => {
        const { sent, pool } = sender();
        const h = new EnvironmentPoolRequestedHandler({ get: async () => ({ organizationId: 'org-a', cellId: 'cell-a' }) }, pool);
        expect(await h.handle(body())).toBeUndefined();
        expect(sent).toEqual([{ organizationId: 'org-a', environmentId: 'env-1', size: 2, cellId: 'cell-a' }]);
    });

    it('sends the machine size the last setup booted at, so the pool there is made at it', async () => {
        const { sent, pool } = sender();
        const big = { memoryMb: 16_384, cpus: 8 };
        await new EnvironmentPoolRequestedHandler({ get: async () => ({ organizationId: 'org-a', cellId: 'cell-a', machineSize: big }) }, pool).handle(body());
        expect(sent).toEqual([{ organizationId: 'org-a', environmentId: 'env-1', size: 2, machineSize: big, cellId: 'cell-a' }]);
    });

    it("never picks a cell from another org's record, nor without a setup; a bad message is invalid", async () => {
        for (const rec of [null, { organizationId: 'org-b', cellId: 'cell-b' }, { organizationId: 'org-a' }]) {
            const { sent, pool } = sender();
            await new EnvironmentPoolRequestedHandler({ get: async () => rec }, pool).handle(body());
            expect(sent).toHaveLength(0);
        }
        const { pool } = sender();
        expect(await new EnvironmentPoolRequestedHandler({ get: async () => null }, pool).handle(body({ size: -1 }))).toMatchObject({ invalid: 'invalid pool request' });
    });
});

// A stop used to share the Run queue and wait behind a backlog of Run
// requests. Control commands now have a queue of their own; a setup is work
// and stays with the Runs, and so does a cancel, which must never pass the
// request it cancels.
describe('command routes', () => {
    it('sends every control command to the control queue and a setup to the Run queue', () => {
        for (const name of Object.values(RuntimeCommandName)) {
            const route = runtimeCommandRoute(name);
            if (name === RuntimeCommandName.EnvironmentSetupRequested) {
                expect(route).toEqual({ routingKey: RUNTIME_RUN_ROUTING_KEY, workflowType: 'RUNTIME_RUN' });
            } else {
                expect(route).toEqual({ routingKey: RUNTIME_CONTROL_ROUTING_KEY, workflowType: 'RUNTIME_CONTROL' });
            }
        }
        expect(runtimeOutboxMessage(RuntimeEventName.RunCancelRequested, { organizationId: 'org-a', repositoryId: '42', prNumber: 7, reason: 'pr_closed' }, 'm').routingKey).toBe(RUNTIME_RUN_ROUTING_KEY);
        // Both queues bind what their routing keys publish.
        expect(RUNTIME_CONTROL_ROUTING_KEY).toMatch(new RegExp(`^${RUNTIME_CONTROL_BINDING.replace(/\./g, '\\.').replace('*', '[^.]+')}$`));
    });

    it('the consumer handles a control command from its own queue', async () => {
        const consumer = new RuntimeCommandConsumer({} as any, new InMemoryRunProjectionStore(), new InMemoryCommandStore(), new InMemoryPrAdmissionStore());
        const msg = runtimeCommandOutboxMessage(
            RuntimeCommandName.StopRequested,
            { scope: 'global', requestedBy: { userId: 'u-1' }, requestedAt: new Date().toISOString(), correlationId: 'corr-1' },
            'm',
        );
        expect(msg.routingKey).toBe(RUNTIME_CONTROL_ROUTING_KEY);
        // Handled, not dead-lettered as an unknown event.
        await expect(consumer.onControl(msg.payload as any)).resolves.toBeUndefined();
    });
});
