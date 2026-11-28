import { consumerWith } from '../consumer/testing';
import { RUNTIME_CONTROL_BINDING, RUNTIME_CONTROL_ROUTING_KEY, RUNTIME_RUN_ROUTING_KEY, RuntimeEventName, runtimeEnvelope, runtimeOutboxMessage } from '@libs/runtime/run';
import { isRunLaneEvent, RuntimeCommandName, runtimeCommandOutboxMessage, runtimeCommandRoute } from '@libs/runtime/contracts/runtime-commands';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';

import { shopRunRequest } from '../../e2e/fixtures';
import { EnvironmentPoolRequestedHandler } from './command-handlers';
import { AmqpPublishRequester, PUBLISH_CONFIRM_TIMEOUT_MS } from '../publish/amqp-publish-requester';
import { confirmTransport } from '../consumer/testing';
import { inMemoryRunDeps } from '../run/testing';
import { runRuntimeRun } from '../run/run-orchestrator';
import { InMemoryPrAdmissionStore } from '../../shared/admission/testing';
import { InMemoryCommandStore, InMemoryDistributedLocks } from '../../shared/persistence/testing';

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
        const consumer = consumerWith({ engine: e as any, projection, commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore(), locks: new InMemoryDistributedLocks() });
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
        const consumer = consumerWith({ engine: e as any, projection, commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore(), locks: new InMemoryDistributedLocks() });
        const a = shopRunRequest();
        const again = shopRunRequest({ pullRequest: a.pullRequest });
        await Promise.all([consumer.handle(asMessage(a)), consumer.handle(asMessage(again))]);
        expect(e.start).toHaveBeenCalledTimes(1);
    });

    it('a setup store that cannot be read fails the message (retried), never boots with the request recipe', async () => {
        const e = engine();
        const setups = { get: async () => Promise.reject(new Error('database down')) };
        const consumer = consumerWith({ engine: e as any, projection: new InMemoryRunProjectionStore(), commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore(), setups });
        await expect(consumer.handle(asMessage(shopRunRequest()))).rejects.toThrow('database down');
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
        await consumerWith({ engine: sized as any, projection: new InMemoryRunProjectionStore(), commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore(), setups: active({ memoryMb: 16_384, cpus: 8 }) }).handle(
            asMessage(shopRunRequest()),
        );
        expect((sized.start.mock.calls[0] as any[])[0].environment.size).toEqual({ memoryMb: 16_384, cpus: 8 });
        const plain = engine();
        const req = shopRunRequest();
        req.environment = { ...req.environment, size: { memoryMb: 65_536, cpus: 16 } };
        await consumerWith({ engine: plain as any, projection: new InMemoryRunProjectionStore(), commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore(), setups: active() }).handle(asMessage(req));
        expect((plain.start.mock.calls[0] as any[])[0].environment).not.toHaveProperty('size');
        // With no active setup (or no setup store) the request's size is not taken either: the cell's default.
        for (const setups of [{ get: async () => null }, undefined]) {
            const none = engine();
            await consumerWith({ engine: none as any, projection: new InMemoryRunProjectionStore(), commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore(), setups }).handle(asMessage(req));
            expect((none.start.mock.calls[0] as any[])[0].environment).not.toHaveProperty('size');
        }
    });

    it("a member's PR boots with its environment's setup, which the primary's repository made", async () => {
        const setups = {
            get: async () => ({
                environmentId: 'shop',
                organizationId: 'org-demo',
                repositoryId: 'repo-shop',
                key: 'k',
                state: 'active' as const,
                steps: [],
                blockers: [],
                machineSize: { memoryMb: 2_048, cpus: 2 },
                requestedAt: '2026-11-05T10:00:00.000Z',
                updatedAt: '2026-11-05T10:00:00.000Z',
            }),
        };
        const base = shopRunRequest();
        const member = shopRunRequest({
            repository: { id: 'repo-billing', name: 'billing', fullName: 'demo/billing' },
            workspace: [
                { repositoryId: 'repo-shop', fullName: 'demo/shop', alias: 'shop', role: 'primary', baseSha: 'c'.repeat(40), headSha: 'c'.repeat(40), source: 'default_branch' },
                { repositoryId: 'repo-billing', fullName: 'demo/billing', alias: 'billing', role: 'member', baseSha: base.pullRequest.baseSha, headSha: base.pullRequest.headSha, source: 'pull_request' },
            ],
        });
        const e = engine();
        await consumerWith({ engine: e as any, projection: new InMemoryRunProjectionStore(), commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore(), setups: setups as any }).handle(asMessage(member));
        expect(e.start).toHaveBeenCalledTimes(1);
        expect((e.start.mock.calls[0] as any[])[0].environment.size).toEqual({ memoryMb: 2_048, cpus: 2 });
        // A Run of another repository that names no workspace is not this setup's.
        const stranger = engine();
        await consumerWith({ engine: stranger as any, projection: new InMemoryRunProjectionStore(), commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore(), setups: setups as any }).handle(
            asMessage(shopRunRequest({ repository: { id: 'repo-other', name: 'other', fullName: 'demo/other' } })),
        );
        expect((stranger.start.mock.calls[0] as any[])[0].environment).not.toHaveProperty('size');
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
        await consumerWith({ engine: e as any, projection: new InMemoryRunProjectionStore(), commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore(), setups: setup as any }).handle(asMessage(req));
        expect((e.start.mock.calls[0] as any[])[0].environment.ready).toEqual({ service: 'web', port: 3000, path: '/api/health', waitSeconds: 90 });
        // Without an active setup the request's ready check is dropped too.
        const none = engine();
        await consumerWith({ engine: none as any, projection: new InMemoryRunProjectionStore(), commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore(), setups: { get: async () => null } }).handle(asMessage(req));
        expect((none.start.mock.calls[0] as any[])[0].environment).not.toHaveProperty('ready');
    });

    it('refuses a Run request whose tokens are not sealed', async () => {
        const e = engine();
        const consumer = consumerWith({ engine: e as any, projection: new InMemoryRunProjectionStore(), commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore() });
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

    it('waits for the broker confirm, with a deadline, and fails the step only when the publish rejects', async () => {
        const msg = await realCheck();
        const publish = jest.fn(async (..._a: unknown[]) => true);
        await new AmqpPublishRequester({ publish } as any).request(msg);
        expect(publish.mock.calls[0][3]).toMatchObject({ persistent: true, messageId: msg.key, timeout: PUBLISH_CONFIRM_TIMEOUT_MS });
        await expect(new AmqpPublishRequester({ publish: async () => false } as any).request(msg)).resolves.toBeUndefined();
        await expect(new AmqpPublishRequester({ publish: async () => Promise.reject(new Error('confirm timeout')) } as any).request(msg)).rejects.toThrow(/confirm timeout/);
    });

    it.each([
        ['a full write buffer, then the broker ack, completes the step', false, null, undefined],
        ['the broker nack fails the step', true, new Error('message nacked'), /message nacked/],
    ])('on the installed transport, %s', async (_name, writeHasRoom, confirm, failure) => {
        const msg = await realCheck();
        const transport = await confirmTransport(writeHasRoom, confirm);
        try {
            const sent = new AmqpPublishRequester({ publish: transport.publish }).request(msg);
            if (failure) await expect(sent).rejects.toThrow(failure);
            else await expect(sent).resolves.toBeUndefined();
        } finally {
            await transport.close();
        }
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
    it('sends every control command to the control queue, and a setup or a suite (work like a Run) to the Run queue', () => {
        const work: string[] = [RuntimeCommandName.EnvironmentSetupRequested, RuntimeCommandName.SuiteRequested, RuntimeCommandName.SuiteRetried];
        for (const name of Object.values(RuntimeCommandName)) {
            const route = runtimeCommandRoute(name);
            if (work.includes(name)) {
                expect(route).toEqual({ routingKey: RUNTIME_RUN_ROUTING_KEY, workflowType: 'RUNTIME_RUN' });
            } else {
                expect(route).toEqual({ routingKey: RUNTIME_CONTROL_ROUTING_KEY, workflowType: 'RUNTIME_CONTROL' });
            }
        }
        expect(runtimeOutboxMessage(RuntimeEventName.RunCancelRequested, { organizationId: 'org-a', repositoryId: '42', prNumber: 7, reason: 'pr_closed' }, 'm').routingKey).toBe(RUNTIME_RUN_ROUTING_KEY);
        // Both queues bind what their routing keys publish.
        expect(RUNTIME_CONTROL_ROUTING_KEY).toMatch(new RegExp(`^${RUNTIME_CONTROL_BINDING.replace(/[\\^$.|?+()[\]{}]/g, '\\$&').replaceAll('*', '[^.]+')}$`));
    });

    it('one rule decides the lane: what the outbox routes to the Run queue is what the Run consumer accepts', () => {
        for (const name of Object.values(RuntimeCommandName)) {
            expect(isRunLaneEvent(name)).toBe(runtimeCommandRoute(name).routingKey === RUNTIME_RUN_ROUTING_KEY);
        }
        expect(isRunLaneEvent(RuntimeEventName.RunRequested)).toBe(true);
        expect(isRunLaneEvent(RuntimeEventName.RunCancelRequested)).toBe(true);
        expect(isRunLaneEvent(RuntimeEventName.PublishRequested)).toBe(false);
        expect(isRunLaneEvent('runtime.unknown')).toBe(false);
    });

    it('the consumer handles a control command from its own queue', async () => {
        const consumer = consumerWith({ engine: {} as any, projection: new InMemoryRunProjectionStore(), commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore() });
        const msg = runtimeCommandOutboxMessage(
            RuntimeCommandName.StopRequested,
            { scope: 'global', requestedBy: { userId: 'u-1' }, requestedAt: new Date().toISOString(), correlationId: 'corr-1' },
            'm',
        );
        expect(msg.routingKey).toBe(RUNTIME_CONTROL_ROUTING_KEY);
        // Handled, not dead-lettered as an unknown event.
        await expect(consumer.onControl(msg.payload as any)).resolves.toBeUndefined();
    });

    it("an owner's token revoke reaches the token store: that org's unused token only", async () => {
        const commands = new InMemoryCommandStore();
        const consumer = consumerWith({ engine: {} as any, projection: new InMemoryRunProjectionStore(), commands, admissions: new InMemoryPrAdmissionStore() });
        const hash = (c: string) => c.repeat(64);
        const expiresAt = new Date(Date.now() + 600_000).toISOString();
        for (const [h, org] of [[hash('a'), 'org-a'], [hash('b'), 'org-b']] as const) {
            await commands.recordCellToken({ tokenHash: h, organizationId: org, topology: 'self_hosted', expiresAt, issuedBy: 'u' });
        }
        const revoke = (tokenHash: string) =>
            consumer.onControl(
                runtimeCommandOutboxMessage(RuntimeCommandName.CellTokenRevoked, { tokenHash, organizationId: 'org-a', revokedBy: { userId: 'u-1' }, revokedAt: new Date().toISOString() }, tokenHash)
                    .payload as any,
            );
        await revoke(hash('a'));
        await revoke(hash('b'));
        expect(commands.tokens.map((t) => [t.organizationId, !!t.revokedAt])).toEqual([
            ['org-a', true],
            ['org-b', false],
        ]);
    });
});
