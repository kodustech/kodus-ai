import { BackfillOrchestratorService } from './backfill-orchestrator.service';

/**
 * Mutation-killing unit tests for the deterministic logic in
 * BackfillOrchestratorService.
 *
 * `clampPositiveInt` and `clampNonNegativeInt` are module-private free
 * functions (not exported), so they are exercised through the public
 * `run()` method: the clamped `stepDays`/`pauseMs`/`batchSize` values are
 * written verbatim into the params of the very first `upsertCheckpoint`
 * call (status 'running', before the window loop). We spy on
 * `upsertCheckpoint` and read those params back to assert the exact
 * clamped numbers, pinning every guard branch and boundary.
 *
 * `sleepInterruptible` is a private method reached via `(instance as any)`.
 *
 * The constructor takes a TypeORM DataSource, a Mongoose Model and the
 * ingestion service; only the ingestion mock and a handful of overridden
 * private methods are actually touched, so the DataSource / Model are inert
 * `{} as any` stubs.
 */
describe('BackfillOrchestratorService (deterministic logic)', () => {
    // Bounds baked into run() — kept in sync with the source constants.
    const MAX_STEP_DAYS = 365;
    const MAX_PAUSE_MS = 60_000;
    const MAX_BATCH = 1_000;
    const DEFAULT_STEP_DAYS = 1;
    const DEFAULT_PAUSE_MS = 5_000;
    const DEFAULT_BATCH = 200;

    function makeService() {
        const ingestionRun = jest.fn().mockResolvedValue({
            scanned: 0,
            upsertedPRs: 0,
            newWatermark: null,
            newWatermarkId: null,
        });
        const svc = new BackfillOrchestratorService(
            {} as any, // analyticsDs (never reached — private DB methods stubbed)
            {} as any, // pullRequestsModel (findOldestCreatedAt stubbed)
            { run: ingestionRun } as any,
        );

        const upsertCheckpoint = jest.fn().mockResolvedValue(undefined);
        // Stub every DB-touching private method so run() stays in-memory.
        (svc as any).readCheckpoint = jest.fn().mockResolvedValue(null);
        (svc as any).findOldestCreatedAt = jest.fn().mockResolvedValue(null);
        (svc as any).upsertCheckpoint = upsertCheckpoint;
        (svc as any).seedIncrementalWatermark = jest
            .fn()
            .mockResolvedValue(undefined);

        return { svc, upsertCheckpoint, ingestionRun };
    }

    /**
     * Runs a single-window backfill and returns the params object written
     * to the FIRST upsertCheckpoint call, which carries the clamped values.
     * `from`..`until` span exactly one day so the loop runs exactly once
     * regardless of the clamped stepDays, and pauseMs never triggers a sleep
     * (cursor >= until after the sole window).
     */
    async function clampedParams(options: Record<string, unknown>) {
        const { svc, upsertCheckpoint } = makeService();
        await svc.run({
            from: '2020-01-01T00:00:00Z',
            until: '2020-01-02T00:00:00Z',
            ...options,
        } as any);
        expect(upsertCheckpoint).toHaveBeenCalled();
        return upsertCheckpoint.mock.calls[0][0].params as {
            stepDays: number;
            pauseMs: number;
            batchSize: number;
        };
    }

    describe('clampPositiveInt (via stepDays: fallback=1, max=365)', () => {
        it('passes a valid mid-range integer through unchanged', async () => {
            const p = await clampedParams({ stepDays: 5 });
            expect(p.stepDays).toBe(5);
        });

        it('returns the fallback for undefined', async () => {
            const p = await clampedParams({ stepDays: undefined });
            expect(p.stepDays).toBe(DEFAULT_STEP_DAYS);
        });

        it('returns the fallback for exactly 0 (boundary: value <= 0)', async () => {
            // Kills `<=` -> `<`: with `<`, 0 would pass through as min(0,max)=0.
            const p = await clampedParams({ stepDays: 0 });
            expect(p.stepDays).toBe(DEFAULT_STEP_DAYS);
        });

        it('passes exactly 1 through (boundary: smallest valid positive)', async () => {
            // Kills `<=` -> `<=? `/off-by-one at the low end: 1 must NOT fall back.
            const p = await clampedParams({ stepDays: 1 });
            expect(p.stepDays).toBe(1);
        });

        it('returns the fallback for a negative value', async () => {
            const p = await clampedParams({ stepDays: -3 });
            expect(p.stepDays).toBe(DEFAULT_STEP_DAYS);
        });

        it('returns the fallback for a non-integer', async () => {
            // Kills removal of the Number.isInteger guard.
            const p = await clampedParams({ stepDays: 2.5 });
            expect(p.stepDays).toBe(DEFAULT_STEP_DAYS);
        });

        it('returns the fallback for NaN', async () => {
            const p = await clampedParams({ stepDays: NaN });
            expect(p.stepDays).toBe(DEFAULT_STEP_DAYS);
        });

        it('returns the fallback for Infinity (kills Number.isFinite guard)', async () => {
            const p = await clampedParams({ stepDays: Infinity });
            expect(p.stepDays).toBe(DEFAULT_STEP_DAYS);
        });

        it('caps a value above max to max (kills Math.min)', async () => {
            const p = await clampedParams({ stepDays: 1000 });
            expect(p.stepDays).toBe(MAX_STEP_DAYS);
        });

        it('passes exactly max through unchanged (boundary at max)', async () => {
            const p = await clampedParams({ stepDays: MAX_STEP_DAYS });
            expect(p.stepDays).toBe(MAX_STEP_DAYS);
        });

        it('passes max-1 through unchanged (below cap)', async () => {
            const p = await clampedParams({ stepDays: MAX_STEP_DAYS - 1 });
            expect(p.stepDays).toBe(MAX_STEP_DAYS - 1);
        });
    });

    describe('clampPositiveInt (via batchSize: fallback=200, max=1000)', () => {
        // A second carrier of clampPositiveInt confirms the fallback/max
        // literals are wired per-call, not a shared constant.
        it('passes a valid value through unchanged', async () => {
            const p = await clampedParams({ batchSize: 300 });
            expect(p.batchSize).toBe(300);
        });

        it('returns the 200 fallback for 0', async () => {
            const p = await clampedParams({ batchSize: 0 });
            expect(p.batchSize).toBe(DEFAULT_BATCH);
        });

        it('caps above-max to 1000', async () => {
            const p = await clampedParams({ batchSize: 5000 });
            expect(p.batchSize).toBe(MAX_BATCH);
        });

        it('uses the 200 default when omitted', async () => {
            const p = await clampedParams({});
            expect(p.batchSize).toBe(DEFAULT_BATCH);
        });
    });

    describe('clampNonNegativeInt (via pauseMs: fallback=5000, max=60000)', () => {
        it('passes a valid mid-range integer through unchanged', async () => {
            const p = await clampedParams({ pauseMs: 3000 });
            expect(p.pauseMs).toBe(3000);
        });

        it('accepts exactly 0 (boundary: value < 0, so 0 is valid)', async () => {
            // Kills `<` -> `<=`: with `<=`, 0 would wrongly fall back to 5000.
            const p = await clampedParams({ pauseMs: 0 });
            expect(p.pauseMs).toBe(0);
        });

        it('returns the fallback for a negative value (-1 boundary)', async () => {
            const p = await clampedParams({ pauseMs: -1 });
            expect(p.pauseMs).toBe(DEFAULT_PAUSE_MS);
        });

        it('returns the fallback for undefined', async () => {
            const p = await clampedParams({ pauseMs: undefined });
            expect(p.pauseMs).toBe(DEFAULT_PAUSE_MS);
        });

        it('returns the fallback for a non-integer', async () => {
            const p = await clampedParams({ pauseMs: 100.5 });
            expect(p.pauseMs).toBe(DEFAULT_PAUSE_MS);
        });

        it('returns the fallback for NaN', async () => {
            const p = await clampedParams({ pauseMs: NaN });
            expect(p.pauseMs).toBe(DEFAULT_PAUSE_MS);
        });

        it('caps above-max to 60000 (kills Math.min)', async () => {
            const p = await clampedParams({ pauseMs: 100_000 });
            expect(p.pauseMs).toBe(MAX_PAUSE_MS);
        });

        it('passes exactly max through unchanged', async () => {
            const p = await clampedParams({ pauseMs: MAX_PAUSE_MS });
            expect(p.pauseMs).toBe(MAX_PAUSE_MS);
        });

        it('passes max-1 through unchanged (below cap)', async () => {
            const p = await clampedParams({ pauseMs: MAX_PAUSE_MS - 1 });
            expect(p.pauseMs).toBe(MAX_PAUSE_MS - 1);
        });
    });

    describe('sleepInterruptible', () => {
        const sleep = (svc: any, ms: number, signal?: AbortSignal) =>
            (svc as any).sleepInterruptible(ms, signal) as Promise<void>;

        it('resolves immediately when the signal is already aborted (no timer)', async () => {
            const { svc } = makeService();
            const controller = new AbortController();
            controller.abort();
            // Real timers: if the early-return branch were removed, this would
            // instead schedule a timer and never resolve within the test.
            await expect(
                sleep(svc, 10_000, controller.signal),
            ).resolves.toBeUndefined();
        });

        it('resolves only after the full delay elapses (kills timer-duration mutants)', async () => {
            jest.useFakeTimers();
            try {
                const { svc } = makeService();
                let resolved = false;
                const p = sleep(svc, 1000).then(() => {
                    resolved = true;
                });

                jest.advanceTimersByTime(999);
                await Promise.resolve();
                expect(resolved).toBe(false); // not yet — one tick short

                jest.advanceTimersByTime(1);
                await p;
                expect(resolved).toBe(true);
            } finally {
                jest.useRealTimers();
            }
        });

        it('resolves early when aborted mid-wait and clears the pending timer', async () => {
            // Real timers so we can observe clearTimeout; abort fires the
            // listener synchronously, so no real delay is incurred.
            const clearSpy = jest.spyOn(global, 'clearTimeout');
            try {
                const { svc } = makeService();
                const controller = new AbortController();
                let resolved = false;
                const p = sleep(svc, 10_000, controller.signal).then(() => {
                    resolved = true;
                });

                await Promise.resolve();
                expect(resolved).toBe(false); // still waiting

                controller.abort();
                await p; // resolves via the abort listener, not the timer
                expect(resolved).toBe(true);
                expect(clearSpy).toHaveBeenCalled();
            } finally {
                clearSpy.mockRestore();
            }
        });
    });
});
