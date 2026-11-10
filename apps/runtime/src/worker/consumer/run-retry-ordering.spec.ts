import { InMemoryPrAdmissionStore } from '../../shared/pr-admission-store';
import { randomUUID } from 'crypto';
import { Nack } from '@golevelup/nestjs-rabbitmq';
import type { ConsumeMessage } from 'amqplib';
import { RuntimeEventName } from '@libs/runtime/run';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { shopRunRequest } from '../../e2e/fixtures';
import { InMemoryCommandStore } from '../../shared/pg-command-store';
import { RuntimeCommandConsumer } from './run-request.consumer';
import { RuntimeRunRetry } from './runtime-run-retry';

const raw = (messageId: string, retry = 0, redelivered = false) =>
    ({
        properties: { messageId, headers: { 'x-retry-count': retry } },
        fields: {
            routingKey: 'workflow.jobs.created.RUNTIME_RUN',
            redelivered,
        },
    }) as unknown as ConsumeMessage;
const envelope = (event_name: string, payload: unknown) => ({
    event_name,
    payload,
});
function fixture() {
    const projection = new InMemoryRunProjectionStore();
    const setups = { get: jest.fn(async () => null) };
    const engine = {
        start: jest.fn(async () => undefined),
        stop: jest.fn(async () => undefined),
    };
    const retry = new RuntimeRunRetry(
        { publish: jest.fn() },
        { maxRetries: 2, delayMs: 100, maxDelayMs: 1000 },
    );
    const consumer = new RuntimeCommandConsumer(
        engine as any,
        projection,
        new InMemoryCommandStore(),
        new InMemoryPrAdmissionStore(),
        undefined,
        setups,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        retry,
    );
    const a = shopRunRequest();
    const b = {
        ...a,
        runId: randomUUID(),
        pullRequest: { ...a.pullRequest, headSha: 'c'.repeat(40) },
    };
    const cancel = {
        organizationId: a.organizationId,
        repositoryId: a.repository.id,
        prNumber: a.pullRequest.number,
        reason: 'pr_closed',
    };
    return { consumer, projection, engine, setups, a, b, cancel };
}

it('a known delayed old head cannot supersede the new head after setup read failed', async () => {
    const { consumer, engine, setups, a, b } = fixture();
    setups.get.mockRejectedValueOnce(new Error('unavailable'));
    await expect(
        consumer.onMessage(
            envelope(RuntimeEventName.RunRequested, a),
            raw('a'),
        ),
    ).rejects.toThrow();
    await consumer.onMessage(
        envelope(RuntimeEventName.RunRequested, b),
        raw('b'),
    );
    await consumer.onMessage(
        envelope(RuntimeEventName.RunRequested, a),
        raw('a', 1),
    );
    expect(engine.start.mock.calls.map((c: any[]) => c[0].runId)).toEqual([
        b.runId,
    ]);
    expect(engine.stop).not.toHaveBeenCalled();
});

it('closing a PR fences an earlier failed request even when no projection exists', async () => {
    const { consumer, engine, setups, a, cancel } = fixture();
    setups.get.mockRejectedValueOnce(new Error('unavailable'));
    await expect(
        consumer.onMessage(
            envelope(RuntimeEventName.RunRequested, a),
            raw('a'),
        ),
    ).rejects.toThrow();
    await consumer.onMessage(
        envelope(RuntimeEventName.RunCancelRequested, cancel),
        raw('close'),
    );
    await consumer.onMessage(
        envelope(RuntimeEventName.RunRequested, a),
        raw('a', 1),
    );
    expect(engine.start).not.toHaveBeenCalled();
});

it('cancel retry after a failed stop spares a newly reopened generation', async () => {
    const { consumer, engine, a, b, cancel } = fixture();
    await consumer.onMessage(
        envelope(RuntimeEventName.RunRequested, a),
        raw('a'),
    );
    engine.stop.mockRejectedValueOnce(new Error('unavailable'));
    await expect(
        consumer.onMessage(
            envelope(RuntimeEventName.RunCancelRequested, cancel),
            raw('close'),
        ),
    ).rejects.toThrow();
    await consumer.onMessage(
        envelope(RuntimeEventName.RunRequested, b),
        raw('b'),
    );
    engine.stop.mockClear();
    await consumer.onMessage(
        envelope(RuntimeEventName.RunCancelRequested, cancel),
        raw('close', 1),
    );
    expect(engine.stop.mock.calls.map((c: any[]) => c[0].runId)).not.toContain(
        b.runId,
    );
});

it('unknown native redelivery cannot replace an existing PR fence', async () => {
    const { consumer, engine, a, b } = fixture();
    await consumer.onMessage(
        envelope(RuntimeEventName.RunRequested, b),
        raw('b'),
    );
    expect(
        await consumer.onMessage(
            envelope(RuntimeEventName.RunRequested, a),
            raw('a', 0, true),
        ),
    ).toBeInstanceOf(Nack);
    expect(engine.start).toHaveBeenCalledTimes(1);
});

it('preserves a terminal old finding when it is delivered after a newer head', async () => {
    const { consumer, projection, engine, a, b } = fixture();
    await consumer.onMessage(
        envelope(RuntimeEventName.RunRequested, a),
        raw('a'),
    );
    await projection.upsert(a.runId, {
        state: 'regression',
        reason: 'proven finding',
        finishedAt: '2026-11-01T00:00:00.000Z',
    });
    await consumer.onMessage(
        envelope(RuntimeEventName.RunRequested, b),
        raw('b'),
    );
    const before = await projection.get(a.runId, {
        organizationId: a.organizationId,
    });
    engine.stop.mockClear();
    await consumer.onMessage(
        envelope(RuntimeEventName.RunRequested, a),
        raw('a', 1),
    );
    expect(
        await projection.get(a.runId, { organizationId: a.organizationId }),
    ).toEqual(before);
    expect(engine.stop).not.toHaveBeenCalled();
});

it('rechecks after setup IO so an interleaving close cannot start an old Run', async () => {
    const { consumer, engine, setups, a, cancel } = fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    setups.get.mockImplementationOnce(async () => {
        entered();
        await new Promise<void>((resolve) => {
            release = resolve;
        });
        return null;
    });
    const pending = consumer.onMessage(
        envelope(RuntimeEventName.RunRequested, a),
        raw('a'),
    );
    await started;
    await consumer.onMessage(
        envelope(RuntimeEventName.RunCancelRequested, cancel),
        raw('close'),
    );
    release();
    await pending;
    expect(engine.start).not.toHaveBeenCalled();
});

it('refuses cancellation without a stable raw broker identity', async () => {
    const { consumer, engine, a, cancel } = fixture();
    await consumer.onMessage(
        envelope(RuntimeEventName.RunRequested, a),
        raw('a'),
    );
    expect(
        await consumer.onMessage(
            envelope(RuntimeEventName.RunCancelRequested, { ...cancel }),
            {
                properties: { headers: {} },
                fields: { routingKey: 'workflow.jobs.created.RUNTIME_RUN' },
            } as unknown as ConsumeMessage,
        ),
    ).toBeInstanceOf(Nack);
    expect(engine.stop).not.toHaveBeenCalled();
});

it('an unknown redelivered cancellation cannot cancel a newer generation', async () => {
    const { consumer, engine, b, cancel } = fixture();
    await consumer.onMessage(
        envelope(RuntimeEventName.RunRequested, b),
        raw('b'),
    );
    expect(
        await consumer.onMessage(
            envelope(RuntimeEventName.RunCancelRequested, cancel),
            raw('unknown-close', 0, true),
        ),
    ).toBeInstanceOf(Nack);
    expect(engine.stop).not.toHaveBeenCalled();
});
