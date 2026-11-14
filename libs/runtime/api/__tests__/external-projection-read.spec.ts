import { MongoRunProjectionStore } from '@libs/runtime/run/adapters/mongo-run-projection.store';
import { ReadOnlyRunProjectionStore } from '../infrastructure/mongo-runtime-readers';

it('propagates bounded client/server timeouts and cancellation to the Mongo driver', async () => {
    const findOne = jest.fn(async (..._args: any[]) => null);
    const store = new MongoRunProjectionStore({ findOne } as never);
    const controller = new AbortController();
    await store.get(
        'run',
        { organizationId: 'org' },
        { timeoutMs: 1250, signal: controller.signal },
    );
    expect(findOne).toHaveBeenCalledWith(
        { runId: 'run', organizationId: 'org' },
        expect.objectContaining({
            timeoutMS: 1250,
            maxTimeMS: 1250,
            signal: controller.signal,
        }),
    );
});

it('bounds lazy database initialization and never issues a query after cancellation', async () => {
    jest.useFakeTimers();
    let ready!: (db: never) => void;
    const db = new Promise<never>((resolve) => {
        ready = resolve;
    });
    const findOne = jest.fn(async (..._args: any[]) => null);
    const reader = new ReadOnlyRunProjectionStore(() => db);
    try {
        const reading = reader.get(
            'run',
            { organizationId: 'org' },
            { timeoutMs: 100 },
        );
        const result = expect(reading).rejects.toThrow();
        await jest.advanceTimersByTimeAsync(100);
        await result;
        ready({ collection: () => ({ findOne }) } as never);
        await Promise.resolve();
        await Promise.resolve();
        expect(findOne).not.toHaveBeenCalled();
    } finally {
        jest.useRealTimers();
    }
});

it('reads only exact proof metadata for external verification instead of full logs and steps', async () => {
    const findOne = jest.fn(async (..._args: any[]) => null);
    const store = new MongoRunProjectionStore({ findOne } as never);
    await store.get(
        'run',
        { organizationId: 'org' },
        { timeoutMs: 1000, view: 'external_verification' },
    );
    const projection = findOne.mock.calls[0][1].projection;
    expect(projection).toMatchObject({
        'runId': 1,
        'organizationId': 1,
        'teamId': 1,
        'repositoryId': 1,
        'prNumber': 1,
        'headSha': 1,
        'imageId': 1,
        'state': 1,
        'finishedAt': 1,
        'probes.probeId': 1,
        'probes.verdict': 1,
        'probes.baseStepIds': 1,
        'probes.prStepIds': 1,
    });
    expect(projection.steps).toBeUndefined();
    expect(projection.probes).toBeUndefined();
});
