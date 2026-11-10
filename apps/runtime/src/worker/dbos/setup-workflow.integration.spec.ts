import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import type { EnvironmentRuntime } from '@libs/runtime/environment';
import { sealSecret } from '@libs/runtime/run';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { InMemoryDistributedLocks } from '../../shared/locks';
import { InMemoryCommandStore } from '../../shared/pg-command-store';
import { devSealKey } from '../../testing/dev-seal-key';
import { ensureDatabase } from '../../shared/runtime-schema';
import { EnvironmentSetupService, InMemoryEnvironmentSetupStore } from '../setup/environment-setup.service';
import { RunEngineService, SETUP_WORKFLOW, setupWorkflowId } from './run-engine.service';

// The environment setup as a DBOS workflow of the real RunEngineService,
// against a real Postgres: the consumer's startSetup returns once DBOS holds
// it, the same command key boots once, and boot/health/record are steps.

// Opt-in: runs against the Postgres RUNTIME_IT_DATABASE_URL names (locally
// postgres://runtime:runtime@localhost:5442/kodus_runtime_it), and skips when
// none is named, as in the backend CI suite, which starts no such database.
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';
const SHA = 'c'.repeat(40);

const acquires: string[] = [];
const env: EnvironmentRuntime = {
    acquire: async (req) => {
        acquires.push(req.idempotencyKey);
        await new Promise((r) => setTimeout(r, 200));
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
    { databaseUrl: url, globalConcurrency: 4, partitionConcurrency: 2, dbosLogLevel: 'warn', sweeper: false } as any,
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

(skip ? describe.skip : describe)('environment setup workflow (integration, real Postgres)', () => {
    beforeAll(async () => {
        process.env.RUNTIME_SWEEPER = 'false';
        await ensureDatabase(url);
        await engine.onModuleInit();
    }, 60_000);

    afterAll(async () => {
        await engine.onApplicationShutdown();
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
});
