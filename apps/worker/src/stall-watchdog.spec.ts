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
        // Whatever names the place, stack or profile, names the burner and
        // never code that ran after it.
        if (stall.stack) {
            expect(stall.stack[0]).toEqual(
                expect.objectContaining({
                    fn: 'burnCpuInATightLoopForTest',
                    file: expect.stringContaining('stall-watchdog.spec'),
                }),
            );
        } else {
            // The inspector answered late (seen in CI: Debugger.enable
            // replays every script of a long in-band Jest run), so the
            // stack it carried is not trusted, and the reason is given.
            expect(stall.stackUnavailable).toBe('answered-late');
        }
        if (stall.hottest?.length) {
            // The profile was taken during the stall: one place holds the CPU.
            expect(stall.hottest[0].pct).toBeGreaterThan(50);
            expect(stall.hottest[0].file).toContain('stall-watchdog.spec');
        }
        if (stall.stack || stall.hottest?.length) {
            expect(stall.location).toContain('stall-watchdog.spec');
        }
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

    it('alerts on a stall inside synchronous native code, without blaming the wrong code', async () => {
        const http = await import('http');
        const { execSync } = await import('child_process');
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
                profileMs: 300,
                maxCapturesPerStall: 1,
                heartbeatUrl: `http://127.0.0.1:${port}/api/v1/heartbeat/tok`,
                pingIntervalMs: 0,
                writeFd: null,
                identity: { role: 'test' },
                onReport: (r) => reports.push(r),
            },
            logger,
        );
        await settle(200);

        // The inspector cannot interrupt a synchronous native call: the
        // main thread answers only after it returns.
        execSync('sleep 2');

        const fail = await waitFor(
            () => hits.find((h) => h.path.endsWith('/fail')),
            15_000,
        );
        server.close();

        const stall = reports.find((r) => r.kind === 'stall');
        expect(stall?.stalledMs).toBeGreaterThanOrEqual(400);
        // The inspector only got an answer after execSync returned: neither
        // the stack nor the profile it would carry is the stall, so neither
        // is used, and the alert says why instead of naming this file.
        const message = JSON.parse(fail.body).message as string;
        expect(stall?.stack).toBeNull();
        expect(stall?.hottest).toBeUndefined();
        expect(stall?.stackUnavailable).toBe('answered-late');
        expect(message).toContain('could not interrupt');
        expect(message).not.toContain('stall-watchdog.spec');
        expect(message).toContain('stalled');
    });
    it('closes a stall that recovers during its capture, so the next stall gets its own report', async () => {
        const reports: StallReport[] = [];
        stop = startStallWatchdog(
            {
                thresholdMs: 400,
                checkIntervalMs: 50,
                tickIntervalMs: 20,
                // The capture outlives the first stall.
                profileMs: 2_000,
                maxCapturesPerStall: 1,
                writeFd: null,
                identity: { role: 'test' },
                onReport: (r) => reports.push(r),
            },
            logger,
        );
        await settle(200);

        burnCpuInATightLoopForTest(1_000); // stall 1, capture starts
        await settle(200); // recovers while that capture is in flight
        burnCpuInATightLoopForTest(2_500); // stall 2, same capture window

        await waitFor(
            () =>
                reports.filter((r) => r.kind === 'stall').length >= 2
                    ? true
                    : undefined,
            15_000,
        );
        const kinds = reports.map((r) => r.kind);
        // Stall 1 is reported before its recovery, and stall 2 is a new one.
        expect(kinds.indexOf('stall')).toBeLessThan(kinds.indexOf('recovered'));
        const firstRecovery = reports.find((r) => r.kind === 'recovered');
        // Its length is the stall's (~1s), not the capture's (~2.4s).
        expect(firstRecovery?.stalledMs).toBeGreaterThanOrEqual(800);
        expect(firstRecovery?.stalledMs).toBeLessThan(1_800);
    });
    it('names the code from the profile when the stall ends during the capture', async () => {
        const reports: StallReport[] = [];
        stop = startStallWatchdog(
            {
                thresholdMs: 400,
                checkIntervalMs: 50,
                tickIntervalMs: 20,
                profileMs: 600,
                maxCapturesPerStall: 1,
                writeFd: null,
                identity: { role: 'test' },
                onReport: (r) => reports.push(r),
            },
            logger,
        );
        await settle(200);

        // Ends while the profile is running, before the stack is read.
        burnCpuInATightLoopForTest(600);

        const stall = await waitFor(() =>
            reports.find((r) => r.kind === 'stall'),
        );
        // The stack was read after the recovery, so it is not used ...
        expect(stall.stack).toBeNull();
        // ... but the profile started inside the stall still names it,
        // instead of blaming a native call that never happened.
        expect(stall.location).toContain('stall-watchdog.spec');
        expect(stall.location).not.toContain('could not interrupt');
        if (stall.stackUnavailable !== 'answered-late') {
            expect(stall.stackUnavailable).toBe('ended-before-read');
            expect(stall.profileIncludesRecovery).toBe(true);
        }
    });
});
