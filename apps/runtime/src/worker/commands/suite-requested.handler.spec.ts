import { runtimeCommandHandlers } from './runtime-command-handlers';
import { RuntimeCommandName } from '@libs/runtime/contracts/runtime-commands';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';

import { InMemoryPrAdmissionStore } from '../../shared/admission/testing';
import { InMemoryCommandStore, InMemoryDistributedLocks } from '../../shared/persistence/testing';
import { SuiteRequestedHandler } from './suite-requested.handler';

// docs/runtime/e2e-suites.md section 11: a suite run starts from its own command, on the Run lane, and the handler only
// enqueues it (a handler never waits on a workflow).

const body = (over: Record<string, unknown> = {}) => ({
    suiteRunId: '0b8e3c2a-6d1f-4a57-9c3e-1f2a3b4c5d6e',
    organizationId: 'org-a',
    environmentId: 'env-shop',
    repositoryId: 'repo-1',
    mode: 'baseline',
    mainSha: 'a'.repeat(40),
    requestedAt: '2026-11-23T12:00:00.000Z',
    key: 'suite-1',
    ...over,
});

describe('SuiteRequestedHandler', () => {
    it('hands a valid request to the engine and returns without waiting for the run', async () => {
        const started: unknown[] = [];
        const h = new SuiteRequestedHandler({ start: async (c) => (started.push(c), 'wf-1') });
        expect(await h.handle(body())).toBeUndefined();
        expect(started).toEqual([expect.objectContaining({ suiteRunId: '0b8e3c2a-6d1f-4a57-9c3e-1f2a3b4c5d6e', mode: 'baseline' })]);
    });

    it('answers invalid for a request that breaks the contract, and starts nothing', async () => {
        const started: unknown[] = [];
        const h = new SuiteRequestedHandler({ start: async (c) => (started.push(c), 'wf-1') });
        // A PR suite names its PR, its head and the merge base; a baseline names none.
        expect(await h.handle(body({ mode: 'ci' }))).toMatchObject({ invalid: expect.any(String) });
        expect(await h.handle(body({ prNumber: 3 }))).toMatchObject({ invalid: expect.any(String) });
        expect(started).toEqual([]);
    });

    it('is a handler of the command only when the worker has an engine for it', () => {
        const base = { engine: {} as any, projection: new InMemoryRunProjectionStore(), commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore(), locks: new InMemoryDistributedLocks() };
        expect(runtimeCommandHandlers(base).some((h) => h.event === RuntimeCommandName.SuiteRequested)).toBe(false);
        expect(runtimeCommandHandlers({ ...base, suites: { start: async () => 'wf' } }).some((h) => h.event === RuntimeCommandName.SuiteRequested)).toBe(true);
    });
});
