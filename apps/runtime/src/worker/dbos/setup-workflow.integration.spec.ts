import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/contracts/runtime-commands';
import type { EnvironmentRuntime } from '@libs/runtime/environment';
import { sealSecret } from '@libs/runtime/run';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { devSealKey } from '../../testing/dev-seal-key';
import { EnvironmentSetupService } from '../setup/environment-setup.service';
import { RunEngineService, SETUP_WORKFLOW, setupWorkflowId } from './run-engine.service';
import { isolatedDatabase } from '../../testing/isolated-database';
import { InMemoryCommandStore, InMemoryDistributedLocks } from '../../shared/persistence/testing';
import { InMemoryEnvironmentSetupStore } from '../setup/testing';

// The environment setup as a DBOS workflow of the real RunEngineService,
// against a real Postgres: the consumer's startSetup returns once DBOS holds
// it, the same command key boots once, and boot/health/record are steps.

// Opt-in: runs against the Postgres RUNTIME_IT_DATABASE_URL names (locally
// postgres://runtime:runtime@localhost:5442/kodus_runtime_it), and skips when
// none is named, as in the backend CI suite, which starts no such database.
// A database of its own: suites in parallel never read each other's rows (isolated-database.ts).
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'setup_workflow');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';
const SHA = 'c'.repeat(40);

const acquires: string[] = [];
// A boot that holds until the test opens it: the setups of one org stay running together.
let openGate: () => void = () => undefined;
let gate: Promise<void> = Promise.resolve();
const env: EnvironmentRuntime = {
    acquire: async (req) => {
        acquires.push(req.idempotencyKey);
        await (req.idempotencyKey.includes(':held-') ? gate : new Promise((r) => setTimeout(r, 200)));
        return { claimId: `claim-${acquires.length}`, cellId: 'cell-1', cellOwner: 'kodus', leaseExpiresAt: '', hardExpiresAt: '', observer: { id: 'o', state: 'ready' }, manifest: { expose: [{ service: 'app', port: 3000, kind: 'http' }] } } as any;
    },
    probe: async () => ({ http: { status: 200 }, vmHealth: 'ok' }) as any,
    exec: async () => ({}) as any,
    reset: async () => undefined,
    release: async () => undefined,
};
const store = new InMemoryEnvironmentSetupStore();
const setup = new EnvironmentSetupService({ envForSetup: () => env }, store);
const engine = new RunEngineService(
    { databaseUrl: url, globalConcurrency: 4, partitionConcurrency: 2, setupPerOrg: 2, dbosLogLevel: 'warn', sweeper: false } as any,
    { forRun: () => ({}) as any, forStop: () => ({}) as any, reap: async () => 0 },
    new InMemoryRunProjectionStore(),
    new RuntimeMetrics(),
    new InMemoryCommandStore(),
    new InMemoryDistributedLocks(),
    setup,
);

const cmd = (key: string): RuntimeEnvironmentSetupRequested => ({
    environmentId: `env-${key}`,
    organizationId: 'org-it',
    teamId: 't',
    repositoryId: 'r',
    repositoryName: 'acme/shop',
    requestedBy: { userId: 'u' },
    requestedAt: '2026-10-31T12:00:00.000Z',
    key,
    ref: { sha: SHA, branch: 'main' },
    recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: null },
    repoToken: sealSecret('ghs_x', devSealKey(), key),
});

const sameEnvironment = (environmentId: string, requestedAt: string): RuntimeEnvironmentSetupRequested => {
    const key = `${environmentId}:${requestedAt}`;
    return { ...cmd(key), environmentId, requestedAt };
};

(skip ? describe.skip : describe)('environment setup workflow (integration, real Postgres)', () => {
    beforeAll(async () => {
        process.env.RUNTIME_SWEEPER = 'false';
        await database.create();
        await engine.onModuleInit();
    }, 60_000);

    afterAll(async () => {
        await engine.onApplicationShutdown();
        await database.drop();
    });

    it('enqueues once per command key and runs boot, health and record as checkpointed steps', async () => {
        const key = `it-${Date.now()}`;
        const id1 = await engine.startSetup(cmd(key));
        const id2 = await engine.startSetup(cmd(key));
        expect(id1).toBe(setupWorkflowId(key));
        expect(id2).toBe(id1);
        const result: any = await DBOS.retrieveWorkflow(id1 as string).getResult();
        expect(result.state).toBe('active');
        expect(acquires.filter((k) => k === `setup:${key}`)).toHaveLength(1);
        expect((await store.get(`env-${key}`))?.state).toBe('active');

        const status = await DBOS.getWorkflowStatus(id1 as string);
        expect(status?.workflowName).toBe(SETUP_WORKFLOW);
        expect(status?.queueName).toBe('runtime-setups');
        const steps = (await DBOS.listWorkflowSteps(id1 as string))!.map((s) => s.name);
        expect(steps).toEqual(expect.arrayContaining(['load', 'boot', 'health', 'release']));
        expect(steps.filter((n) => n.startsWith('record:')).length).toBeGreaterThan(5);
    }, 60_000);

    it('runs as many setups of one organization at once as its limit allows, and the next one waits its turn', async () => {
        gate = new Promise<void>((r) => (openGate = r));
        const keys = [1, 2, 3].map((n) => `held-${Date.now()}-${n}`);
        const ids = [];
        for (const key of keys) ids.push((await engine.startSetup(cmd(key))) as string);
        const booting = () => keys.filter((k) => acquires.includes(`setup:${k}`));
        const deadline = Date.now() + 20_000;
        while (booting().length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
        // Give the queue a few polls to (wrongly) start the third.
        await new Promise((r) => setTimeout(r, 3_000));
        expect(booting()).toHaveLength(2);
        const waiting = keys.find((k) => !acquires.includes(`setup:${k}`))!;
        expect((await DBOS.getWorkflowStatus(setupWorkflowId(waiting)))?.status).toBe('ENQUEUED');
        // Nothing is recorded for the waiting one: the product still shows its request.
        expect(await store.get(`env-${waiting}`)).toBeNull();

        openGate();
        const results: any[] = await Promise.all(ids.map((id) => DBOS.retrieveWorkflow(id).getResult()));
        expect(results.map((r) => r.state)).toEqual(['active', 'active', 'active']);
    }, 60_000);

    it('runs one setup of an environment at a time: a second request waits for the live one and records after it', async () => {
        gate = new Promise<void>((r) => (openGate = r));
        const environmentId = `env-serial-${Date.now()}`;
        // The default keys the product mints: `<environmentId>:<requestedAt>`, held by the ':held-' marker.
        const first = sameEnvironment(environmentId, `held-1`);
        const second = sameEnvironment(environmentId, `held-2`);
        const id1 = (await engine.startSetup(first)) as string;
        const deadline = Date.now() + 20_000;
        while (!acquires.includes(`setup:${first.key}`) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
        const id2 = (await engine.startSetup(second)) as string;
        // The queue (setupPerOrg 2) starts the second; it must not build beside the first.
        const started = Date.now() + 30_000;
        while ((await DBOS.getWorkflowStatus(id2))?.status === 'ENQUEUED' && Date.now() < started) await new Promise((r) => setTimeout(r, 200));
        await new Promise((r) => setTimeout(r, 1_500));
        expect((await DBOS.getWorkflowStatus(id2))?.status).toBe('PENDING');
        expect(acquires).not.toContain(`setup:${second.key}`);

        openGate();
        const results: any[] = await Promise.all([id1, id2].map((id) => DBOS.retrieveWorkflow(id).getResult()));
        expect(results.map((r) => r.state)).toEqual(['active', 'active']);
        expect(acquires.indexOf(`setup:${first.key}`)).toBeLessThan(acquires.indexOf(`setup:${second.key}`));
    }, 60_000);
});
