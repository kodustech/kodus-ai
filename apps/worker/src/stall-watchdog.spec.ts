import { StallReport, startStallWatchdog } from './stall-watchdog';

// A named, synchronous CPU burner: the stand-in for whatever freezes a worker
// in production. The watchdog must name it in the report.
function burnCpuInATightLoopForTest(ms: number): number {
    const end = Date.now() + ms;
    let x = 0;
    while (Date.now() < end) {
        x = (x * 31 + 7) % 1_000_003;
    }
    return x;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
    pick: () => T | undefined,
    timeoutMs = 10_000,
): Promise<T> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const v = pick();
        if (v !== undefined) return v;
        await settle(20);
    }
    throw new Error('timed out waiting for the watchdog report');
}

describe('startStallWatchdog (real worker thread)', () => {
    jest.setTimeout(30_000);

    const logger = { warn: jest.fn(), error: jest.fn() };
    let stop: (() => void) | undefined;

    afterEach(() => {
        stop?.();
        stop = undefined;
        jest.clearAllMocks();
    });

    function start(reports: StallReport[]) {
        stop = startStallWatchdog(
            {
                thresholdMs: 400,
                checkIntervalMs: 50,
                tickIntervalMs: 20,
                profileMs: 300,
                maxCapturesPerStall: 1,
                writeFd: null,
                identity: { role: 'test' },
                onReport: (r) => reports.push(r),
            },
            logger,
        );
    }

    it('names the function the main thread is stuck in, then resumes it', async () => {
        const reports: StallReport[] = [];
        start(reports);
        await settle(200); // thread up and ticking

        const result = burnCpuInATightLoopForTest(3_000);

        // The main thread ran to completion: the pause was released.
        expect(typeof result).toBe('number');

        const stall = await waitFor(() =>
            reports.find((r) => r.kind === 'stall'),
        );
        expect(stall.stalledMs).toBeGreaterThanOrEqual(400);
        expect(stall.stack?.map((f) => f.fn)).toContain(
            'burnCpuInATightLoopForTest',
        );
        // The paused stack is authoritative (the profiler can fold an
        // inlined function into its caller); the top frame is the burner.
        expect(stall.stack?.[0]).toEqual(
            expect.objectContaining({
                fn: 'burnCpuInATightLoopForTest',
                file: expect.stringContaining('stall-watchdog.spec'),
            }),
        );
        // The profile was taken during the stall: one place holds the CPU.
        expect(stall.hottest?.[0].pct).toBeGreaterThan(50);
        expect(stall.hottest?.[0].file).toContain('stall-watchdog.spec');
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('reports the recovery with the stall length', async () => {
        const reports: StallReport[] = [];
        start(reports);
        await settle(200);

        burnCpuInATightLoopForTest(1_500);

        const recovered = await waitFor(() =>
            reports.find((r) => r.kind === 'recovered'),
        );
        expect(recovered.stalledMs).toBeGreaterThanOrEqual(1_000);
    });

    it('stays quiet while the main thread keeps ticking', async () => {
        const reports: StallReport[] = [];
        start(reports);

        // Short bursts below the threshold, with the loop free in between.
        for (let i = 0; i < 5; i++) {
            burnCpuInATightLoopForTest(100);
            await settle(100);
        }
        await settle(300);

        expect(reports).toEqual([]);
    });

    it('posts the stall to the BetterStack heartbeat /fail with the location', async () => {
        const http = await import('http');
        const hits: Array<{ path: string; body: string }> = [];
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                hits.push({ path: req.url ?? '', body });
                res.end('ok');
            });
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const { port } = server.address() as { port: number };

        const reports: StallReport[] = [];
        stop = startStallWatchdog(
            {
                thresholdMs: 400,
                checkIntervalMs: 50,
                tickIntervalMs: 20,
                profileMs: 0,
                maxCapturesPerStall: 1,
                heartbeatUrl: `http://127.0.0.1:${port}/api/v1/heartbeat/tok`,
                pingIntervalMs: 0,
                writeFd: null,
                identity: { role: 'test', instanceId: 'ip-test' },
                onReport: (r) => reports.push(r),
            },
            logger,
        );
        await settle(200);
        burnCpuInATightLoopForTest(2_000);

        const fail = await waitFor(() =>
            hits.find((h) => h.path.endsWith('/fail')),
        );
        server.close();

        const payload = JSON.parse(fail.body);
        expect(payload.message).toContain('burnCpuInATightLoopForTest');
        expect(payload.message).toContain('instanceId=ip-test');
        expect(payload.context.monitor).toBe('worker_stall');
        // No healthy ping configured (pingIntervalMs: 0).
        expect(hits.filter((h) => !h.path.endsWith('/fail'))).toEqual([]);
    });
});
