import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { isolatedDatabase } from '../../testing/isolated-database';
import { InMemoryCommandStore, InMemoryDistributedLocks } from '../../shared/persistence/testing';
import { RunEngineService, SUITE_WORKFLOW, suiteWorkflowId } from './run-engine.service';

// The suite as a DBOS workflow of the real RunEngineService, against a real Postgres: the handler's start returns once DBOS
// holds it, the same suite run starts once, and the work is journalled as the steps the service names.
// Opt-in: RUNTIME_IT_DATABASE_URL.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'suite_workflow');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const bodies: string[] = [];
const suite = {
    run: async (cmd: RuntimeSuiteRequested, step: <T>(name: string, fn: () => Promise<T>) => Promise<T>) => {
        const started = await step('suite:start', async () => ({ at: 1 }));
        bodies.push(`${cmd.suiteRunId}:${started.at}`);
        return step('suite:run', async () => ({ status: 'ran', suiteRunId: cmd.suiteRunId, state: 'passed', replayed: false }));
    },
};
const engine = new RunEngineService(
    { databaseUrl: url, globalConcurrency: 4, partitionConcurrency: 2, suitePerOrg: 2, suiteConcurrency: 2, dbosLogLevel: 'warn', sweeper: false } as any,
    { forRun: () => ({}) as any, forStop: () => ({}) as any, reap: async () => 0 },
    new InMemoryRunProjectionStore(),
    new RuntimeMetrics(),
    new InMemoryCommandStore(),
    new InMemoryDistributedLocks(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    suite as any,
);

const cmd = (id: string): RuntimeSuiteRequested => ({
    suiteRunId: id,
    organizationId: 'org-it',
    environmentId: 'env-1',
    repositoryId: 'repo-1',
    mode: 'baseline',
    mainSha: 'a'.repeat(40),
    requestedAt: '2026-11-23T12:00:00.000Z',
    key: id,
});

(skip ? describe.skip : describe)('the suite workflow (integration, real Postgres)', () => {
    beforeAll(async () => {
        await database.create();
        await engine.onModuleInit();
    }, 60_000);
    afterAll(async () => {
        await engine.onApplicationShutdown();
        await database.drop();
    });

    it('enqueues once per suite run on the suites queue and journals the service steps', async () => {
        const id = '0b5c2f6e-6f1d-4c53-9a43-1d1f5f3a9c11';
        const first = await engine.startSuite(cmd(id));
        const again = await engine.startSuite(cmd(id));
        expect(first).toBe(suiteWorkflowId(id));
        expect(again).toBe(first);
        const result: any = await DBOS.retrieveWorkflow(first as string).getResult();
        expect(result).toMatchObject({ status: 'ran', state: 'passed' });
        expect(bodies).toEqual([`${id}:1`]);
        const status = await DBOS.getWorkflowStatus(first as string);
        expect(status?.workflowName).toBe(SUITE_WORKFLOW);
        expect(status?.queueName).toBe('runtime-suites');
        expect((await DBOS.listWorkflowSteps(first as string))!.map((s) => s.name)).toEqual(expect.arrayContaining(['suite:start', 'suite:run']));
    }, 60_000);

    it('has no suite to start when the worker has no suite service', async () => {
        const bare = new RunEngineService({ databaseUrl: url, globalConcurrency: 1, partitionConcurrency: 1 } as any, {} as any, new InMemoryRunProjectionStore(), new RuntimeMetrics(), new InMemoryCommandStore(), new InMemoryDistributedLocks());
        expect(await bare.startSuite(cmd('0b5c2f6e-6f1d-4c53-9a43-1d1f5f3a9c12'))).toBe(false);
    });
});
