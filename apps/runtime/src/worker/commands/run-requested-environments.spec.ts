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

describe('the recipe a Run records', () => {
    it("says where the environment's recipe came from, so the Run page never calls a sent recipe one read from main", async () => {
        const projection = new InMemoryRunProjectionStore();
        const engine = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined) };
        const req = shopRunRequest();
        const setups = {
            get: async () =>
                ({
                    environmentId: req.environment.environmentId,
                    organizationId: req.organizationId,
                    repositoryId: req.repository.id,
                    key: 'k',
                    state: 'active',
                    steps: [],
                    blockers: [],
                    requestedAt: '2026-11-27T00:00:00.000Z',
                    updatedAt: '2026-11-27T00:00:00.000Z',
                    recipe: { path: '.kodus/workspace.yaml', sha: 'a'.repeat(40), state: 'found', content: 'version: 1\n', origin: 'submitted' },
                }) as any,
        };
        const h = new RunRequestedHandler(engine as any, projection, { isStopped: async () => false } as any, new InMemoryDistributedLocks(), new InMemoryPrAdmissionStore(), setups);

        await h.requested(req);

        expect((await projection.get(req.runId))?.recipe).toMatchObject({ origin: 'submitted', path: '.kodus/workspace.yaml', sha: 'a'.repeat(40) });
    });
});

describe("the boot a Run waits for", () => {
    const setupWith = (req: ReturnType<typeof shopRunRequest>, steps: unknown[]) => ({
        get: async () =>
            ({
                environmentId: req.environment.environmentId,
                organizationId: req.organizationId,
                repositoryId: req.repository.id,
                key: 'k',
                state: 'active',
                steps,
                blockers: [],
                requestedAt: '2026-11-27T00:00:00.000Z',
                updatedAt: '2026-11-27T00:00:00.000Z',
                recipe: { path: '.kodus/workspace.yaml', sha: 'a'.repeat(40), state: 'found', content: 'version: 1\n' },
            }) as any,
    });

    it("carries the boot the environment's setup measured, never one the product sent", async () => {
        const engine = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined) };
        const req = shopRunRequest();
        const sent = { ...req, environment: { ...req.environment, setupBootMs: 1 } } as any;
        const setups = setupWith(req, [{ name: 'boot', state: 'done', startedAt: '2026-11-27T00:00:00.000Z', durationMs: 878_000 }]);
        const h = new RunRequestedHandler(engine as any, new InMemoryRunProjectionStore(), { isStopped: async () => false } as any, new InMemoryDistributedLocks(), new InMemoryPrAdmissionStore(), setups);

        await h.requested(sent);

        expect((engine.start.mock.calls[0] as any)[0].environment.setupBootMs).toBe(878_000);
    });

    it('carries none when the setup measured no finished boot', async () => {
        const engine = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined) };
        const req = shopRunRequest();
        const h = new RunRequestedHandler(engine as any, new InMemoryRunProjectionStore(), { isStopped: async () => false } as any, new InMemoryDistributedLocks(), new InMemoryPrAdmissionStore(), setupWith(req, []));

        await h.requested(req);

        expect((engine.start.mock.calls[0] as any)[0].environment.setupBootMs).toBeUndefined();
    });
});

