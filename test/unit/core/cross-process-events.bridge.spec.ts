import {
    CrossProcessEventsBridge,
    resolvePgSslOption,
} from '@libs/core/workflow/infrastructure/cross-process-events.bridge';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

/**
 * The LISTEN client's SSL handling MUST match what TypeORMFactory ultimately
 * passes to the pool — a mismatch is what shipped the 2026-07-13 prod
 * incident (raw `pg.Client` got `ssl: true`, failed TLS handshake against RDS,
 * `ensureInfra` never ran, table never created, worker's INSERT storm).
 */
describe('resolvePgSslOption', () => {
    it('returns extra.ssl verbatim when present (managed Postgres / RDS)', () => {
        expect(
            resolvePgSslOption({
                ssl: true,
                extra: { ssl: { rejectUnauthorized: false } },
            }),
        ).toEqual({ rejectUnauthorized: false });
    });

    it('normalizes a bare `ssl: true` to `{rejectUnauthorized:false}`', () => {
        expect(resolvePgSslOption({ ssl: true })).toEqual({
            rejectUnauthorized: false,
        });
    });

    it('returns undefined when the URL declares sslmode= (driver reads it)', () => {
        expect(
            resolvePgSslOption({
                url: 'postgres://u:p@h/db?sslmode=require',
                ssl: true,
                extra: { ssl: { rejectUnauthorized: false } },
            }),
        ).toBeUndefined();
    });

    it('passes through `ssl: false` for local self-hosted setups', () => {
        expect(resolvePgSslOption({ ssl: false })).toBe(false);
    });

    it('passes through undefined when nothing is configured', () => {
        expect(resolvePgSslOption({})).toBeUndefined();
    });

    it('honors extra.ssl even when top-level ssl is unset', () => {
        expect(
            resolvePgSslOption({ extra: { ssl: { rejectUnauthorized: true } } }),
        ).toEqual({ rejectUnauthorized: true });
    });
});

describe('CrossProcessEventsBridge', () => {
    beforeEach(() => {
        CrossProcessEventsBridge.resetPrimaryForTests();
    });

    const makeBridge = (query = jest.fn().mockResolvedValue(undefined)) => {
        const eventEmitter = { emit: jest.fn() };
        const dataSource = { query, options: {} };
        const bridge = new CrossProcessEventsBridge(
            dataSource as any,
            eventEmitter as any,
        );
        return { bridge, eventEmitter, query };
    };

    const payload = {
        organizationAndTeamData: { organizationId: 'org-1' },
        pullRequestNumber: 42,
    };

    it('stores the envelope in a row and notifies only its id', async () => {
        const query = jest
            .fn()
            .mockResolvedValueOnce([{ id: 77 }]) // INSERT ... RETURNING id
            .mockResolvedValueOnce(undefined); // pg_notify
        const { bridge } = makeBridge(query);

        await bridge.forwardPullRequestClosed(payload);
        // forward() now batches; flush the buffer synchronously so the
        // INSERT+NOTIFY actually run in this test.
        await bridge.flushForwardBufferForTests();

        const [insertSql, insertArgs] = query.mock.calls[0];
        expect(insertSql).toContain('INSERT INTO kodus_cross_process_events');
        // The batch flush uses a multi-row VALUES list ($1::jsonb),($2::jsonb)...
        // — with one envelope, it's just `($1::jsonb)`.
        expect(insertSql).toContain('($1::jsonb)');
        const envelope = JSON.parse(insertArgs[0]);
        expect(envelope.instanceId).toBe(bridge.instanceId);
        expect(envelope.name).toBe('pull-request.closed');
        expect(envelope.payload.pullRequestNumber).toBe(42);

        expect(query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
            'kodus_cross_process_events',
            '77',
        ]);
    });

    it('large payloads are not dropped (row transport has no NOTIFY cap)', async () => {
        const query = jest
            .fn()
            .mockResolvedValueOnce([{ id: 78 }])
            .mockResolvedValueOnce(undefined);
        const { bridge } = makeBridge(query);

        await bridge.forwardPullRequestClosed({
            files: Array.from({ length: 500 }, (_, i) => ({
                filename: `src/file-${i}.ts`,
                status: 'modified',
            })),
        });
        await bridge.flushForwardBufferForTests();

        expect(query).toHaveBeenCalledTimes(2);
    });

    it('coalesces multiple emits within a flush window into one INSERT+NOTIFY', async () => {
        const query = jest
            .fn()
            .mockResolvedValueOnce([{ id: 100 }, { id: 101 }, { id: 102 }])
            .mockResolvedValueOnce(undefined);
        const { bridge } = makeBridge(query);

        // Three emits before flush — should collapse to one round-trip.
        await bridge.forwardPullRequestClosed({ ...payload, pullRequestNumber: 1 });
        await bridge.forwardPullRequestClosed({ ...payload, pullRequestNumber: 2 });
        await bridge.forwardPullRequestClosed({ ...payload, pullRequestNumber: 3 });
        await bridge.flushForwardBufferForTests();

        expect(query).toHaveBeenCalledTimes(2);
        const [insertSql] = query.mock.calls[0];
        // Multi-row VALUES: ($1::jsonb),($2::jsonb),($3::jsonb)
        expect(insertSql).toContain('($1::jsonb),($2::jsonb),($3::jsonb)');
        // Single NOTIFY with comma-joined ids.
        expect(query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
            'kodus_cross_process_events',
            '100,101,102',
        ]);
    });

    it('does NOT re-forward bridged payloads (no ping-pong)', async () => {
        const { bridge, query } = makeBridge();

        await bridge.forwardPullRequestClosed({
            ...payload,
            __kodusBridged: true,
        });

        expect(query).not.toHaveBeenCalled();
    });

    it('publish failures never throw (emit site unaffected)', async () => {
        const { bridge } = makeBridge(
            jest.fn().mockRejectedValue(new Error('db down')),
        );

        // The emit itself is now buffered so it can't throw at the
        // emit site regardless. The actual DB failure happens on flush,
        // and must not propagate either.
        await expect(
            bridge.forwardPrExecutionUpdated(payload),
        ).resolves.toBeUndefined();
        await expect(
            bridge.flushForwardBufferForTests(),
        ).resolves.toBeUndefined();
    });

    it('semaphore: over-limit deliverBatch drops the whole batch and counts the drop', async () => {
        const query = jest.fn().mockResolvedValue([]);
        const { bridge } = makeBridge(query);

        // Push inflightDeliveries near the cap; deliverBatch with a
        // batch that would exceed the cap must be rejected wholesale
        // without hitting the DB.
        (bridge as any).inflightDeliveries = 49;
        await (bridge as any).deliverBatch([1, 2, 3, 4, 5]);

        expect(query).not.toHaveBeenCalled();
        // 5 dropped envelopes should be counted in metrics.
        expect((bridge as any).metrics.deliverDropped).toBe(5);
        // Semaphore rolled back — no dangling counter.
        expect((bridge as any).inflightDeliveries).toBe(49);
    });

    it('semaphore: over-limit deliverById drops and does not touch DB', async () => {
        const query = jest.fn().mockResolvedValue([]);
        const { bridge } = makeBridge(query);

        (bridge as any).inflightDeliveries = 50;
        await (bridge as any).deliverById('77');

        expect(query).not.toHaveBeenCalled();
        expect((bridge as any).metrics.deliverDropped).toBe(1);
    });

    it('ensureInfra is idempotent — runs at most once per process', async () => {
        const query = jest.fn().mockResolvedValue([]);
        const { bridge } = makeBridge(query);

        await (bridge as any).ensureInfra();
        await (bridge as any).ensureInfra();
        await (bridge as any).ensureInfra();

        // Only the very first call issues the CREATE TABLE. Reconnect
        // no longer re-runs it (that was the whole point of the split
        // — reconnect must not touch the pool).
        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS');
    });

    it('sweep runs DELETE on the primary; no-op when inert or not ready', async () => {
        // With advisory lock (added for multi-instance safety) the
        // sweep issues 3 queries: try_advisory_lock → DELETE →
        // advisory_unlock. First mock says "we got the lock" so DELETE
        // proceeds.
        const query = jest
            .fn()
            .mockResolvedValueOnce([{ locked: true }]) // pg_try_advisory_lock
            .mockResolvedValueOnce(undefined) // DELETE
            .mockResolvedValueOnce(undefined); // pg_advisory_unlock
        const { bridge } = makeBridge(query);

        // Not ready → skip everything.
        await bridge.sweepExpiredRows();
        expect(query).not.toHaveBeenCalled();

        (bridge as any).infraReady = true;
        await bridge.sweepExpiredRows();
        expect(query).toHaveBeenCalledTimes(3);
        expect(query.mock.calls[0][0]).toContain('pg_try_advisory_lock');
        expect(query.mock.calls[1][0]).toContain('DELETE FROM kodus_cross_process_events');
        expect(query.mock.calls[1][0]).toContain("interval '60 minutes'");
        expect(query.mock.calls[2][0]).toContain('pg_advisory_unlock');
    });

    it('sweep skips DELETE when another task holds the advisory lock', async () => {
        // Simulate: the other instance got the lock first.
        const query = jest
            .fn()
            .mockResolvedValueOnce([{ locked: false }]);
        const { bridge } = makeBridge(query);
        (bridge as any).infraReady = true;

        await bridge.sweepExpiredRows();

        // Only the lock probe ran; DELETE was skipped, no unlock
        // needed (we don't hold the lock).
        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0][0]).toContain('pg_try_advisory_lock');
    });

    it('polling fallback anchors to MAX(id) on first tick (no cold replay)', async () => {
        const query = jest
            .fn()
            .mockResolvedValueOnce([{ max: '999' }]); // MAX query
        const { bridge } = makeBridge(query);
        (bridge as any).infraReady = true;

        await bridge.pollFallback();

        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0][0]).toContain('MAX(id)');
        // The anchor MUST also apply the 1s visibility gap, otherwise
        // it can pin to a pre-commit id that will be replayed later.
        expect(query.mock.calls[0][0]).toContain(
            "created_at < now() - interval '1 second'",
        );
        expect((bridge as any).pollLastSeenId).toBe(999n);
        expect((bridge as any).pollInitialized).toBe(true);
    });

    it('polling fallback delivers only rows above the water mark (with visibility gap)', async () => {
        const query = jest
            .fn()
            .mockResolvedValueOnce([{ max: '100' }]) // first tick anchors
            .mockResolvedValueOnce([
                {
                    id: '101',
                    envelope: {
                        instanceId: 'other-instance',
                        name: 'pull-request.closed',
                        payload: { pullRequestNumber: 7 },
                    },
                    created_at: new Date(),
                },
            ]);
        const { bridge, eventEmitter } = makeBridge(query);
        (bridge as any).infraReady = true;

        await bridge.pollFallback(); // anchors at 100
        await bridge.pollFallback(); // fetches > 100

        expect(query).toHaveBeenCalledTimes(2);
        const followupSql = query.mock.calls[1][0];
        expect(followupSql).toContain('WHERE id > $1');
        // Visibility gap: only consider rows whose commit is at least
        // 1s old, otherwise a concurrent bigserial commit can slip past.
        expect(followupSql).toContain(
            "created_at < now() - interval '1 second'",
        );
        expect(query.mock.calls[1][1]).toEqual(['100']);
        // Foreign envelope was re-emitted to the local bus.
        expect(eventEmitter.emit).toHaveBeenCalledWith(
            'pull-request.closed',
            expect.objectContaining({
                pullRequestNumber: 7,
                __kodusBridged: true,
            }),
        );
        expect((bridge as any).pollLastSeenId).toBe(101n);
    });

    it('deliverBatch counts missing rows (envelope swept before delivery)', async () => {
        // Batch asks for 3 ids; DB returns only 1 (rows 2 and 3 were
        // swept by TTL or never inserted). The delivered one goes out,
        // the missing 2 are counted in `envelopeMissing`.
        const query = jest.fn().mockResolvedValue([
            {
                id: '10',
                envelope: {
                    instanceId: 'other-instance',
                    name: 'pull-request.closed',
                    payload: { pullRequestNumber: 10 },
                },
                created_at: new Date(),
            },
        ]);
        const { bridge, eventEmitter } = makeBridge(query);

        await (bridge as any).deliverBatch([10, 11, 12]);

        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0][0]).toContain('WHERE id = ANY($1::bigint[])');
        expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
        expect((bridge as any).metrics.delivered).toBe(1);
        expect((bridge as any).metrics.envelopeMissing).toBe(2);
        // Semaphore released after the batch completes.
        expect((bridge as any).inflightDeliveries).toBe(0);
    });

    it('deliverBatch releases the semaphore even on query error', async () => {
        const query = jest.fn().mockRejectedValue(new Error('db down'));
        const { bridge } = makeBridge(query);

        await (bridge as any).deliverBatch([1, 2, 3]);

        expect((bridge as any).inflightDeliveries).toBe(0);
        expect((bridge as any).metrics.deliverErrors).toBe(3);
    });

    it('deliverById releases the semaphore even on query error', async () => {
        const query = jest.fn().mockRejectedValue(new Error('db down'));
        const { bridge } = makeBridge(query);

        await (bridge as any).deliverById('77');

        expect((bridge as any).inflightDeliveries).toBe(0);
        expect((bridge as any).metrics.deliverErrors).toBe(1);
    });

    it('polling skips envelopes already delivered locally via LISTEN (dedup)', async () => {
        // Scenario: with 2 API tasks, each task LISTENs AND polls. When
        // an envelope arrives via LISTEN and is re-emitted locally, the
        // subsequent poll would see the same row and re-emit it again
        // — doubling handler invocations per event per task. The local
        // deliveredIds LRU prevents that within one instance.
        const foreignEnvelope = {
            instanceId: 'other-instance',
            name: 'pull-request.closed',
            payload: { pullRequestNumber: 42 },
        };
        // Poll returns MAX(id) then the same row.
        const query = jest
            .fn()
            .mockResolvedValueOnce([{ max: '100' }]) // anchor
            .mockResolvedValueOnce([
                {
                    id: '101',
                    envelope: foreignEnvelope,
                    created_at: new Date(),
                },
            ]);
        const { bridge, eventEmitter } = makeBridge(query);
        (bridge as any).infraReady = true;

        // Simulate LISTEN already delivered id=101 in this instance.
        (bridge as any).markDelivered('101');

        await bridge.pollFallback(); // anchors
        await bridge.pollFallback(); // sees id=101 → skipped

        // Row was seen (watermark advanced) but emit was NOT called
        // because deliveredIds already had it.
        expect((bridge as any).pollLastSeenId).toBe(101n);
        expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('deliveredIds LRU is bounded — drops oldest entries', async () => {
        const { bridge } = makeBridge();
        // Grow the set past the cap (10k). Use a smaller test size and
        // hack the cap? Easier: mark 10.001 ids and check the first is
        // gone. But 10k iterations in a spec is fine (<50ms).
        const N = 10_001;
        for (let i = 1; i <= N; i++) {
            (bridge as any).markDelivered(String(i));
        }
        // Size stays at the cap.
        expect((bridge as any).deliveredIds.size).toBe(10_000);
        // Oldest ('1') was evicted, newest ('10001') is present.
        expect((bridge as any).deliveredIds.has('1')).toBe(false);
        expect((bridge as any).deliveredIds.has('10001')).toBe(true);
    });

    it('deliveredIds is idempotent — same id twice keeps size same', () => {
        const { bridge } = makeBridge();
        (bridge as any).markDelivered('77');
        (bridge as any).markDelivered('77');
        (bridge as any).markDelivered('77');
        expect((bridge as any).deliveredIds.size).toBe(1);
    });

    it('polling ignores rows written by this instance (no self-replay)', async () => {
        const { bridge, eventEmitter } = makeBridge();
        // Simulate a poll that returns an envelope written by THIS
        // instance (as if we polled our own recent forwards). The
        // shouldReemit guard must skip it.
        const query = jest
            .fn()
            .mockResolvedValueOnce([{ max: '50' }])
            .mockResolvedValueOnce([
                {
                    id: '51',
                    envelope: {
                        instanceId: bridge.instanceId, // ← our own
                        name: 'pull-request.closed',
                        payload: { pullRequestNumber: 1 },
                    },
                    created_at: new Date(),
                },
            ]);
        (bridge as any).dataSource.query = query;
        (bridge as any).infraReady = true;

        await bridge.pollFallback();
        await bridge.pollFallback();

        // Row was seen (watermark advanced), but NOT re-emitted.
        expect((bridge as any).pollLastSeenId).toBe(51n);
        expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('notification handler parses single id, comma list, empty, and garbage', () => {
        // The channel-level parsing lives inside the client.on('notification')
        // callback — mirrors that same logic here. The empty-string guard
        // matters: without it, Number('') is 0 (not NaN) and would fire
        // a wasted SELECT on id=0.
        const parse = (payload: string): number[] =>
            payload
                .split(',')
                .map((raw) => raw.trim())
                .filter((raw) => raw.length > 0)
                .map((raw) => Number(raw))
                .filter((n) => Number.isFinite(n) && n > 0);

        expect(parse('77')).toEqual([77]);
        expect(parse('77,78,79')).toEqual([77, 78, 79]);
        expect(parse('77, 78 , 79')).toEqual([77, 78, 79]);
        expect(parse('')).toEqual([]);
        expect(parse('abc,def')).toEqual([]);
        expect(parse('77,junk,79')).toEqual([77, 79]);
        // Trailing / leading commas must not become id=0.
        expect(parse('77,')).toEqual([77]);
        expect(parse(',77')).toEqual([77]);
        expect(parse(',,')).toEqual([]);
    });

    it('inert (duplicate) instance does not forward or start LISTEN', async () => {
        // First bridge claims primary.
        const primary = makeBridge().bridge;
        expect(primary.isPrimary).toBe(true);

        // Second bridge in the same test — inert.
        const secondary = makeBridge().bridge;
        expect(secondary.isPrimary).toBe(false);

        // shouldForward on the inert instance is always false, regardless
        // of payload. This guards against the "N instances forwarding N
        // times" bug documented at the top of the class.
        expect(secondary.shouldForward({ any: 'payload' })).toBe(false);

        // shouldReemit on the inert instance still works (it's a pure
        // check on envelope shape — no side-effects). Only actual
        // eventEmitter.emit is gated by isPrimary in the callers.
        expect(
            secondary.shouldReemit({
                instanceId: 'other',
                name: 'pull-request.closed',
                payload: {},
            }),
        ).toBe(true);
    });

    it('re-emits only foreign, known events', () => {
        const { bridge } = makeBridge();

        const envelope = (over: Partial<any>) => ({
            // Containerized apps are all PID 1, so the guard is a random
            // per-process instance id — never process.pid.
            instanceId: 'another-instance',
            name: 'pull-request.closed',
            payload,
            ...over,
        });

        expect(bridge.shouldReemit(envelope({}))).toBe(true);
        // Own instance → the local bus already delivered it.
        expect(
            bridge.shouldReemit(envelope({ instanceId: bridge.instanceId })),
        ).toBe(false);
        // Unknown event names are ignored.
        expect(bridge.shouldReemit(envelope({ name: 'something-else' }))).toBe(
            false,
        );
        expect(bridge.shouldReemit(null)).toBe(false);
    });
});
