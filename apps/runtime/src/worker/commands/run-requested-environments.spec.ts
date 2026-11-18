import { randomUUID } from 'crypto';

import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';

import { shopRunRequest } from '../../e2e/fixtures';
import { RunRequestedHandler } from './run-requested.handler';
import { InMemoryPrAdmissionStore } from '../../shared/admission/testing';
import { InMemoryDistributedLocks } from '../../shared/persistence/testing';

// "Run on this PR" for a repository in several environments queues one Run
// per environment, of the same head: each one runs, as the live-Run index
// allows one live Run per environment, PR and head.

const handler = () => {
    const projection = new InMemoryRunProjectionStore();
    const engine = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined) };
    const h = new RunRequestedHandler(engine as any, projection, { isStopped: async () => false } as any, new InMemoryDistributedLocks(), new InMemoryPrAdmissionStore());
    return { h, engine, projection };
};
const inEnvironment = (environmentId: string) => {
    const base = shopRunRequest();
    return { ...base, runId: randomUUID(), environment: { ...base.environment, environmentId } };
};

describe('a PR head requested in several environments', () => {
    it('queues a Run in each environment', async () => {
        const { h, engine } = handler();
        const a = inEnvironment('env-a');
        const b = inEnvironment('env-b');

        await h.requested(a);
        await h.requested(b);

        expect(engine.start.mock.calls.map(([r]: any) => r.runId)).toEqual([a.runId, b.runId]);
        expect(engine.stop).not.toHaveBeenCalled();
    });

    it('still queues one Run per environment and head', async () => {
        const { h, engine } = handler();
        await h.requested(inEnvironment('env-a'));
        await h.requested(inEnvironment('env-a'));

        expect(engine.start).toHaveBeenCalledTimes(1);
    });
});
