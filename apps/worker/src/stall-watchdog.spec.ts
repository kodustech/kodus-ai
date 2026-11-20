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

// Real threads and real clocks: in a long in-band CI run the process also
// pauses on its own (GC), so a test only looks at stalls it provoked
// (startedAt after `arm()`), and a run is retried on a starved machine.
jest.retryTimes(2, { logErrorsBeforeRetry: true });

describe('startStallWatchdog (real worker thread)', () => {
    let armedAt = Number.POSITIVE_INFINITY;
    /**
     * From now on, stalls are this test's own. Arms after a free window
     * longer than the watchdog's check interval, so a stall of the test
     * process itself (GC) has already been closed; then a stall is ours if
     * it began after that moment (minus a tick or two of slack: its start is
     * the last tick before the gap).
     */
    const arm = async () => {
        await settle(200);
        armedAt = Date.now();
    };
    const ours = (startedAt?: number) => (startedAt ?? 0) >= armedAt - 50;
    const keep = (reports: StallReport[]) => (r: StallReport) => {
        if (ours(r.startedAt)) reports.push(r);
    };
    const ourFail = (h: { path: string; body: string }) =>
        h.path.endsWith('/fail') && ours(JSON.parse(h.body).context?.startedAt);
    jest.setTimeout(30_000);

    const logger = { warn: jest.fn(), error: jest.fn() };
    let stop: (() => void) | undefined;

    afterEach(() => {
        armedAt = Number.POSITIVE_INFINITY;
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
                onReport: keep(reports),
            },
            logger,
        );
    }

    it('names the function the main thread is stuck in, then resumes it', async () => {
        const reports: StallReport[] = [];
        start(reports);
        await settle(200); // thread up and ticking

        await arm();
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
            // Whether the ticker ran before the late pause landed is a race
            // the scenario cannot fix: either reason is honest here.
            expect(['answered-late', 'ended-before-read']).toContain(
                stall.stackUnavailable,
            );
        }
        if (stall.stackUnavailable === undefined && stall.error === undefined) {
            // The inspector answered in time, so the profile belongs to the
            // stall: one place holds the CPU.
            expect(stall.hottest?.length).toBeGreaterThan(0);
            expect(stall.hottest![0].pct).toBeGreaterThan(50);
            expect(stall.hottest![0].file).toContain('stall-watchdog.spec');
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

        await arm();
        burnCpuInATightLoopForTest(1_500);

        const recovered = await waitFor(() =>
            reports.find((r) => r.kind === 'recovered'),
        );
        expect(recovered.stalledMs).toBeGreaterThanOrEqual(1_000);
    });

    it('stays quiet while the main thread keeps ticking', async () => {
        const reports: StallReport[] = [];
        start(reports);

        await arm();
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
                // Alert on the first report: these stalls are short.
                alertMs: 1,
                writeFd: null,
                identity: { role: 'test', instanceId: 'ip-test' },
                onReport: keep(reports),
            },
            logger,
        );
        await settle(200);
        await arm();
        burnCpuInATightLoopForTest(2_000);

        const fail = await waitFor(() => hits.find(ourFail));
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
        // Every report, ours or not: printed when ours never comes, since this
        // case fails on CI runners and not locally.
        const all: StallReport[] = [];
        const keepOurs = keep(reports);
        stop = startStallWatchdog(
            {
                thresholdMs: 400,
                checkIntervalMs: 50,
                tickIntervalMs: 20,
                profileMs: 300,
                maxCapturesPerStall: 1,
                heartbeatUrl: `http://127.0.0.1:${port}/api/v1/heartbeat/tok`,
                pingIntervalMs: 0,
                // Alert on the first report: these stalls are short.
                alertMs: 1,
                writeFd: null,
                identity: { role: 'test' },
                onReport: (r) => {
                    all.push(r);
                    keepOurs(r);
                },
            },
            logger,
        );
        await settle(200);

        // The inspector cannot interrupt a synchronous native call: the
        // main thread answers only after it returns.
        await arm();
        execSync('sleep 2');

        const fail = await waitFor(() => hits.find(ourFail), 15_000);
        // The report reaches this thread as a worker message and the alert as
        // an HTTP request: on a loaded runner the alert can land first.
        const stall = await waitFor(
            () => reports.find((r) => r.kind === 'stall'),
            15_000,
        ).catch(() => {
            throw new Error(
                `no stall report of ours (armedAt ${armedAt}); alert: ${
                    fail.body
                }; every report: ${JSON.stringify(
                    all.map((r) => ({
                        kind: r.kind,
                        startedAt: r.startedAt,
                        stalledMs: r.stalledMs,
                        capture: (r as any).capture,
                        stackUnavailable: r.stackUnavailable,
                        location: (r as any).location,
                    })),
                )}`,
            );
        });
        server.close();

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
                // The capture (~3.4s+) outlives the first stall (~1s).
                profileMs: 3_000,
                maxCapturesPerStall: 1,
                writeFd: null,
                identity: { role: 'test' },
                onReport: keep(reports),
            },
            logger,
        );
        await settle(200);

        await arm();
        burnCpuInATightLoopForTest(1_000); // stall 1, capture starts
        await settle(200); // recovers while that capture is in flight
        burnCpuInATightLoopForTest(3_500); // stall 2, same capture window

        await waitFor(
            () =>
                reports.filter((r) => r.kind === 'stall').length >= 2
                    ? true
                    : undefined,
            15_000,
        );
        // Select by identity, not emission order: stall 1 is the captured
        // one (stall 2 may be reported as not-captured, and first).
        const firstStall = reports.find(
            (r) => r.kind === 'stall' && r.stackUnavailable !== 'not-captured',
        );
        // The stall report carries the stall's length (~1s), not the
        // capture's (>= ~3.4s). The upper bound leaves room for a slow
        // in-band CI run, where Debugger.enable replays every loaded script.
        expect(firstStall?.stalledMs).toBeGreaterThanOrEqual(800);
        expect(firstStall?.stalledMs).toBeLessThan(2_600);
        // Its recovery is the one with the same start.
        const firstRecovery = reports.find(
            (r) =>
                r.kind === 'recovered' && r.startedAt === firstStall?.startedAt,
        );
        // Stall 1 is reported before its own recovery.
        expect(firstStall).toBeDefined();
        expect(firstRecovery).toBeDefined();
        expect(reports.indexOf(firstStall!)).toBeLessThan(
            reports.indexOf(firstRecovery!),
        );
        // Its length is the stall's (~1s), not the capture's (>= ~3.4s).
        expect(firstRecovery?.stalledMs).toBeGreaterThanOrEqual(800);
        expect(firstRecovery?.stalledMs).toBeLessThan(2_600);
    });
    it('names the code from the profile when the stall ends during the capture', async () => {
        const reports: StallReport[] = [];
        stop = startStallWatchdog(
            {
                thresholdMs: 400,
                checkIntervalMs: 50,
                tickIntervalMs: 20,
                // The profile must start inside the stall and outlive it,
                // even where starting it takes seconds (a huge in-band CI
                // process); answers up to 10s are trusted here.
                profileMs: 5_000,
                lateAnswerMs: 10_000,
                maxCapturesPerStall: 1,
                writeFd: null,
                identity: { role: 'test' },
                onReport: keep(reports),
            },
            logger,
        );
        await settle(200);

        // Ends while the profile is running, before the stack is read.
        await arm();
        burnCpuInATightLoopForTest(5_000);

        const stall = await waitFor(() =>
            reports.find((r) => r.kind === 'stall'),
        );
        // The stack was read after the recovery, so it is not used ...
        expect(stall.stack).toBeNull();
        // ... but the profile started inside the stall still names it,
        // instead of blaming a native call that never happened.
        expect(stall.location).toContain('stall-watchdog.spec');
        expect(stall.location).not.toContain('could not interrupt');
        // The profile started inside the stall and ran past its end.
        expect(stall.profileIncludesRecovery).toBe(true);
        // Real measurements from both inspector phases.
        expect(stall.inspectorAnswerMs!).toBeGreaterThan(0);
        expect(stall.profilerAnswerMs!).toBeGreaterThan(0);
        // The scenario fixes the reason: the main thread ran again before
        // the read. (The late-pause branch has its own test below.)
        expect(stall.stackUnavailable).toBe('ended-before-read');
    });

    it('reports and alerts a stall that starts and ends while an earlier capture is still running', async () => {
        const reports: StallReport[] = [];
        stop = startStallWatchdog(
            {
                thresholdMs: 400,
                checkIntervalMs: 50,
                tickIntervalMs: 20,
                // Stall 1's capture outlives both stalls.
                profileMs: 2_500,
                maxCapturesPerStall: 1,
                writeFd: null,
                identity: { role: 'test' },
                onReport: keep(reports),
            },
            logger,
        );
        await settle(200);

        await arm();
        burnCpuInATightLoopForTest(1_000); // stall 1: captured
        await settle(200);
        burnCpuInATightLoopForTest(800); // stall 2: ends before that capture
        await settle(200);

        const stalls = await waitFor(() => {
            const found = reports.filter((r) => r.kind === 'stall');
            return found.length >= 2 ? found : undefined;
        }, 15_000);
        const uncaptured = stalls.find(
            (r) => r.stackUnavailable === 'not-captured',
        );
        // Not downgraded to a mere recovery: it is a stall report, with its
        // own length and the reason it has no location.
        expect(uncaptured).toBeDefined();
        expect(uncaptured?.stalledMs).toBeGreaterThanOrEqual(400);
        expect(uncaptured?.stalledMs).toBeLessThan(1_600);
        expect(uncaptured?.location).toContain('not captured');
    });
    it('does not send a healthy ping when it starts, so a new task never closes an open stall incident', async () => {
        const http = await import('http');
        const hits: string[] = [];
        const server = http.createServer((req, res) => {
            hits.push(req.url ?? '');
            res.end('ok');
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const { port } = server.address() as { port: number };

        stop = startStallWatchdog(
            {
                thresholdMs: 400,
                checkIntervalMs: 50,
                tickIntervalMs: 20,
                heartbeatUrl: `http://127.0.0.1:${port}/api/v1/heartbeat/tok`,
                pingIntervalMs: 800,
                writeFd: null,
                identity: { role: 'test' },
            },
            logger,
        );
        await settle(500);
        // (A /fail from a pause of the test process itself is not a ping.)
        const pings = () => hits.filter((h) => !h.endsWith('/fail'));
        // Nothing before the first full interval ...
        expect(pings()).toEqual([]);
        // ... then the regular healthy ping.
        await waitFor(() => (pings().length ? true : undefined), 5_000);
        server.close();
        expect(pings()[0]).toBe('/api/v1/heartbeat/tok');
    });
    it('does not trust a pause that answered late while the thread had not ticked again', async () => {
        const { execSync } = await import('child_process');
        const reports: StallReport[] = [];
        stop = startStallWatchdog(
            {
                thresholdMs: 400,
                checkIntervalMs: 50,
                tickIntervalMs: 20,
                // No profile: the verdict can only come from the pause.
                profileMs: 0,
                maxCapturesPerStall: 1,
                writeFd: null,
                identity: { role: 'test' },
                onReport: keep(reports),
            },
            logger,
        );
        await settle(200);

        await arm();
        // The inspector cannot get in during the native call; it answers
        // only once it returns, while JavaScript keeps the thread busy
        // without ticking. The pause then lands in that later JavaScript.
        execSync('sleep 2');
        // Long enough that the pause still lands in it where Debugger.enable
        // itself takes seconds (a huge in-band CI process).
        burnCpuInATightLoopForTest(6_000);

        const stall = await waitFor(
            () => reports.find((r) => r.kind === 'stall'),
            15_000,
        );
        // Late answer, no tick in between: the frames are of the code that
        // ran after the stall, so they are not offered as the location.
        expect(stall.stackUnavailable).toBe('answered-late');
        expect(stall.stack).toBeNull();
        expect(stall.inspectorAnswerMs!).toBeGreaterThan(1_000);
        expect(stall.location).not.toContain('burnCpuInATightLoopForTest');
    });
    it('offers the pause it read in time as unverifiedStack when only the profiler was late, never as the location', async () => {
        const { execSync } = await import('child_process');
        const reports: StallReport[] = [];
        stop = startStallWatchdog(
            {
                thresholdMs: 400,
                checkIntervalMs: 50,
                tickIntervalMs: 20,
                profileMs: 200,
                maxCapturesPerStall: 1,
                // High enough that even a slow in-band CI inspector reads
                // the pause in time, while the native call below holds the
                // profiler start well past it: the verdict is deterministic.
                lateAnswerMs: 8_000,
                writeFd: null,
                identity: { role: 'test' },
                onReport: keep(reports),
            },
            logger,
        );
        await settle(200);

        await arm();
        // The native call holds the profiler start past lateAnswerMs; the
        // pause then lands, in time and without a tick, in the JavaScript
        // that follows.
        execSync('sleep 10');
        burnCpuInATightLoopForTest(8_000);

        const stall = await waitFor(
            () => reports.find((r) => r.kind === 'stall'),
            25_000,
        );
        expect(stall.profilerAnswerMs!).toBeGreaterThan(8_000);
        expect(stall.inspectorAnswerMs!).toBeLessThanOrEqual(8_000);
        expect(stall.stack).toBeNull();
        expect(stall.stackUnavailable).toBe('answered-late');
        expect(stall.location).not.toContain('burnCpuInATightLoopForTest');
        // Offered as a lead, which here names the code after the native
        // call: that is why it is not the location.
        expect(stall.unverifiedStack?.[0]?.fn).toBe(
            'burnCpuInATightLoopForTest',
        );
    }, 60_000);
    it('warns every stall at its first report and alerts critical only past alertMs, once each', async () => {
        const http = await import('http');
        const hits: { path: string; body: string }[] = [];
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
                alertMs: 2_500,
                heartbeatUrl: `http://127.0.0.1:${port}/api/v1/heartbeat/critical`,
                warnHeartbeatUrl: `http://127.0.0.1:${port}/api/v1/heartbeat/warn`,
                pingIntervalMs: 0,
                writeFd: null,
                identity: { role: 'test' },
                onReport: keep(reports),
            },
            logger,
        );
        await settle(200);
        const failsFor = (which: string, startedAt?: number) =>
            hits.filter(
                (h) =>
                    h.path === `/api/v1/heartbeat/${which}/fail` &&
                    JSON.parse(h.body).context?.startedAt === startedAt,
            );

        // Short: warned, not alerted critical.
        await arm();
        burnCpuInATightLoopForTest(1_200);
        const short = await waitFor(() =>
            reports.find((r) => r.kind === 'recovered'),
        );
        await waitFor(() => {
            const f = failsFor('warn', short.startedAt);
            return f.length ? f : undefined;
        });
        await settle(300);
        expect(failsFor('warn', short.startedAt)).toHaveLength(1);
        expect(failsFor('critical', short.startedAt)).toHaveLength(0);
        expect(
            JSON.parse(failsFor('warn', short.startedAt)[0].body).context.level,
        ).toBe('warning');

        // Long: warned once and alerted critical once.
        await arm();
        burnCpuInATightLoopForTest(4_500);
        const long = await waitFor(
            () =>
                reports.find(
                    (r) =>
                        r.kind === 'recovered' &&
                        r.startedAt !== short.startedAt,
                ),
            15_000,
        );
        const critical = await waitFor(() => {
            const f = failsFor('critical', long.startedAt);
            return f.length ? f : undefined;
        });
        await settle(300);
        server.close();
        expect(critical).toHaveLength(1);
        expect(failsFor('warn', long.startedAt)).toHaveLength(1);
        const context = JSON.parse(critical[0].body).context;
        expect(context.level).toBe('critical');
        expect(context.stalledMs).toBeGreaterThanOrEqual(2_500);
    });
    it('names the job, PR, stage and tool call that were running when the stall began', async () => {
        const { runActivity, updateActivity, beginToolActivity } =
            await import('@libs/core/infrastructure/activity/activity-registry');
        const reports: StallReport[] = [];
        stop = startStallWatchdog(
            {
                thresholdMs: 400,
                checkIntervalMs: 50,
                tickIntervalMs: 20,
                profileMs: 0,
                maxCapturesPerStall: 1,
                writeFd: null,
                identity: { role: 'test' },
                onReport: keep(reports),
            },
            logger,
        );
        await settle(200);

        await runActivity('job-77', { queue: 'code_review' }, async () => {
            updateActivity({
                stage: 'AgentReviewStage',
                organizationId: 'org-1',
                repository: 'acme/app',
                prNumber: 8132,
            });
            const end = beginToolActivity('grep', 'pattern=foo path=.');
            // The tool's own await: the snapshot leaves before the freeze.
            await settle(100);
            await arm();
            burnCpuInATightLoopForTest(1_500);
            end();
        });

        const stall = await waitFor(() =>
            reports.find((r) => r.kind === 'stall'),
        );
        expect(stall.activeJobs).toEqual([
            expect.objectContaining({
                jobId: 'job-77',
                queue: 'code_review',
                stage: 'AgentReviewStage',
                organizationId: 'org-1',
                repository: 'acme/app',
                prNumber: 8132,
                tools: [
                    expect.objectContaining({
                        tool: 'grep',
                        args: 'pattern=foo path=.',
                    }),
                ],
            }),
        ]);
    });
    it('treats a zero or invalid lateAnswerMs as the 1s default, so stacks are still trusted', async () => {
        for (const lateAnswerMs of [0, -1, Number.NaN]) {
            const reports: StallReport[] = [];
            stop = startStallWatchdog(
                {
                    thresholdMs: 400,
                    checkIntervalMs: 50,
                    tickIntervalMs: 20,
                    profileMs: 0,
                    lateAnswerMs,
                    maxCapturesPerStall: 1,
                    writeFd: null,
                    identity: { role: 'test' },
                    onReport: keep(reports),
                },
                logger,
            );
            await arm();
            // Long enough that the stack is read inside the stall.
            burnCpuInATightLoopForTest(4_000);
            const stall = await waitFor(() =>
                reports.find((r) => r.kind === 'stall'),
            );
            // Read inside the stall, so the verdict follows the answer time
            // against the 1s default. With 0 forwarded, every answer would
            // count as late and the stack would be discarded.
            expect(stall.inspectorAnswerMs!).toBeGreaterThan(0);
            if (stall.inspectorAnswerMs! <= 1_000) {
                expect(stall.stackUnavailable).toBeUndefined();
                expect(stall.stack?.[0]?.fn).toBe('burnCpuInATightLoopForTest');
            } else {
                // A slow inspector (huge in-band CI process) is late either way.
                expect(stall.stackUnavailable).toBe('answered-late');
                expect(stall.stack).toBeNull();
            }
            stop();
            stop = undefined;
        }
    });
});
