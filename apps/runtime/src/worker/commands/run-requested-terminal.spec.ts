import { InMemoryPrAdmissionStore } from '../../shared/admission/pr-admission-store';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { shopRunRequest } from '../../e2e/fixtures';
import { InMemoryDistributedLocks } from '../../shared/persistence/locks';
import { RunRequestedHandler } from './run-requested.handler';

it('does not admit a terminal Run again when its request is redelivered', async () => {
    const request = shopRunRequest();
    const projection = new InMemoryRunProjectionStore();
    await projection.upsert(request.runId, { organizationId: request.organizationId, state: 'errored', attempt: request.attempt, requestedAt: request.requestedAt });
    const engine = { start: jest.fn(), stop: jest.fn() };
    const handler = new RunRequestedHandler(engine as any, projection, { isStopped: async () => false } as any, new InMemoryDistributedLocks(), new InMemoryPrAdmissionStore());
    await handler.requested(request);
    expect(engine.start).not.toHaveBeenCalled();
    expect(engine.stop).not.toHaveBeenCalled();
});
