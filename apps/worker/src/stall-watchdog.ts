import { Worker } from 'worker_threads';
import { createLogger } from '@libs/core/log/logger';

/**
 * Catches a stalled main thread in the act.
 *
 * The EventLoopMonitor runs on the thread it measures, so a worker frozen in
 * synchronous code reports nothing until it recovers, and nothing at all when
 * it never does (ECS kills it first). This watchdog runs in its own thread,
 * which keeps running while the main thread is stuck. When the main thread
 * stops ticking for `thresholdMs` it connects to the main thread's inspector
 * (in-process, no port), samples a short CPU profile and pauses the main
 * thread for one instant to read its JavaScript stack, then resumes it. The
 * report goes straight to stdout (fd 1, so CloudWatch gets it even if the main
 * thread never runs again) and, when a heartbeat URL is set, to BetterStack
 * as an incident that names the code the worker is stuck in.
 *
 * Inspector commands are serviced through V8 interrupts, which a busy
 * JavaScript loop honours; that is how DevTools pauses an infinite loop. Code
 * that never checks interrupts (a long synchronous native call) yields no
 * stack, and the report says so instead of hanging: every inspector call is
 * bounded.
 */

export interface StallFrame {
    fn: string;
    file: string;
    line: number;
    col: number;
}

export interface StallReport {
    kind: 'stall' | 'recovered';
    stalledMs: number;
    capture?: number;
    /** The stack was read after the main thread ran again: not the stall. */
    stackReadAfterRecovery?: boolean;
    /**
     * Why `stack` is null. `ended-before-read`: the stall ended before the
     * stack was read. `answered-late`: the main thread answered the
     * inspector only after more than a second, so what it showed may have
     * run after the stall (a synchronous native call, a long builtin such as
     * a regex, a long GC). `no-answer`: it never answered within the bound.
     * `not-captured`: the watchdog was still capturing an earlier stall.
     */
    stackUnavailable?:
        'ended-before-read' | 'answered-late' | 'no-answer' | 'not-captured';
    /** The profile also covers time after the stall ended. */
    profileIncludesRecovery?: boolean;
    /**
     * How long the stack read took, from Debugger.enable to the pause. On
     * purpose it includes Debugger.enable, which the main thread serves (and
     * which replays every loaded script): if that alone outlasts the stall,
     * the pause lands on whatever runs next, so it must count as late. In
     * the worker (one webpack bundle) the replay costs milliseconds.
     */
    inspectorAnswerMs?: number;
    /** How long the main thread took to start the profile. */
    profilerAnswerMs?: number;
    /** Human-readable location, as used in the log line and the alert. */
    location?: string;
    stack?: StallFrame[] | null;
    hottest?: Array<{ fn: string; file: string; line: number; pct: number }>;
    hottestPath?: StallFrame[];
    error?: string;
}

export interface StallWatchdogOptions {
    /** Main thread silent for this long counts as a stall. */
    thresholdMs?: number;
    /** How often the watchdog thread checks the main thread's last tick. */
    checkIntervalMs?: number;
    /** How often the main thread ticks. */
    tickIntervalMs?: number;
    /** CPU profile length per capture; 0 skips the profile. */
    profileMs?: number;
    /** Captures per stall: one at the threshold, then every `recaptureMs`. */
    maxCapturesPerStall?: number;
    recaptureMs?: number;
    /** BetterStack heartbeat; empty disables alerting (reports still log). */
    heartbeatUrl?: string;
    /** Healthy ping cadence for the heartbeat, so it does not alert on silence. */
    pingIntervalMs?: number;
    /** Labels copied into every report (role, instance). */
    identity?: Record<string, string>;
    /** File descriptor for the immediate JSON report line; null disables. */
    writeFd?: number | null;
    /** Main-thread callback, delivered once the main thread runs again. */
    onReport?: (report: StallReport) => void;
}

type WatchdogLogger = Pick<ReturnType<typeof createLogger>, 'warn' | 'error'>;

/**
 * Body of the watchdog thread. Serialized with Function#toString and run with
 * `eval: true`, because the worker app is a single webpack bundle and has no
 * separate file to point a Worker at. It must stay self-contained: no imports,
 * no closure over module scope, and Node built-ins only through
 * process.getBuiltinModule (webpack rewrites `require`).
 */
/* istanbul ignore next -- runs inside the worker thread */
export function stallWatchdogThread(): void {
    const wt = process.getBuiltinModule(
        'node:worker_threads',
    ) as typeof import('worker_threads');
    const inspector = process.getBuiltinModule(
        'node:inspector',
    ) as typeof import('inspector');
    const fs = process.getBuiltinModule('node:fs') as typeof import('fs');
    const nodeModule = process.getBuiltinModule(
        'node:module',
    ) as typeof import('module');

    const { sab, cfg } = wt.workerData as {
        sab: SharedArrayBuffer;
        cfg: Required<
            Omit<StallWatchdogOptions, 'onReport' | 'identity' | 'writeFd'>
        > & { identity: Record<string, string>; writeFd: number | null };
    };
    const lastTick = new BigInt64Array(sab);
    const parent = wt.parentPort;

    // One record per stall. A capture keeps a reference to the stall it
    // started for, so a recovery (or a new stall) while it is in flight
    // never mixes the two.
    let stall: {
        start: number;
        captures: number;
        endedMs?: number;
        recoveryPending?: boolean;
    } | null = null;
    let capturingFor: typeof stall = null;
    let lastPing = 0;

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    function post(
        session: InstanceType<typeof inspector.Session>,
        method: string,
        params: object = {},
        timeoutMs = 5_000,
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`${method} timed out`)),
                timeoutMs,
            );
            session.post(method, params, (err: Error | null, res: unknown) => {
                clearTimeout(timer);
                if (err) reject(err);
                else resolve(res);
            });
        });
    }

    // Bundle positions -> source positions, through the hidden source map
    // shipped next to the bundle. Best effort: raw positions when absent.
    const maps = new Map<string, any>();
    function sourceMapFor(url: string): any {
        if (maps.has(url)) return maps.get(url);
        let sm: any = null;
        try {
            const file = url.startsWith('file://')
                ? decodeURIComponent(new URL(url).pathname)
                : url;
            if (file && fs.existsSync(`${file}.map`)) {
                sm = new (nodeModule as any).SourceMap(
                    JSON.parse(fs.readFileSync(`${file}.map`, 'utf8')),
                );
            }
        } catch {
            sm = null;
        }
        maps.set(url, sm);
        return sm;
    }
    function frame(fn: string, url: string, line0: number, col0: number) {
        const sm = url ? sourceMapFor(url) : null;
        if (sm) {
            try {
                const e = sm.findEntry(line0, col0);
                if (e && e.originalSource) {
                    return {
                        fn: fn || e.name || '(anonymous)',
                        file: String(e.originalSource).replace(
                            /^webpack:\/\/[^/]*\//,
                            '',
                        ),
                        line: e.originalLine + 1,
                        col: e.originalColumn + 1,
                    };
                }
            } catch {
                // fall through to the raw position
            }
        }
        return {
            fn: fn || '(anonymous)',
            file: url || '(native)',
            line: line0 + 1,
            col: col0 + 1,
        };
    }

    function summarize(profile: any) {
        const byId = new Map<number, any>();
        const parentOf = new Map<number, number>();
        for (const n of profile.nodes) {
            byId.set(n.id, n);
            for (const c of n.children ?? []) parentOf.set(c, n.id);
        }
        const self = new Map<number, number>();
        const deltas: number[] = profile.timeDeltas ?? [];
        let total = 0;
        (profile.samples ?? []).forEach((id: number, i: number) => {
            const d = deltas[i] ?? 0;
            self.set(id, (self.get(id) ?? 0) + d);
            total += d;
        });
        const IDLE = new Set(['(idle)', '(program)', '(garbage collector)']);
        const byFn = new Map<string, { n: any; t: number }>();
        for (const [id, t] of self) {
            const n = byId.get(id);
            const cf = n.callFrame;
            const key = `${cf.functionName}|${cf.url}|${cf.lineNumber}`;
            const cur = byFn.get(key) ?? { n, t: 0 };
            cur.t += t;
            byFn.set(key, cur);
        }
        const ranked = [...byFn.values()]
            .filter((x) => !IDLE.has(x.n.callFrame.functionName))
            .sort((a, b) => b.t - a.t);
        const hottest = ranked.slice(0, 10).map(({ n, t }) => {
            const cf = n.callFrame;
            const f = frame(
                cf.functionName,
                cf.url,
                cf.lineNumber,
                cf.columnNumber,
            );
            return {
                fn: f.fn,
                file: f.file,
                line: f.line,
                pct: total ? Math.round((1000 * t) / total) / 10 : 0,
            };
        });
        // Root-to-leaf path of the single hottest node: who called it.
        const hottestPath: ReturnType<typeof frame>[] = [];
        if (ranked[0]) {
            let id: number | undefined = ranked[0].n.id;
            while (id !== undefined && hottestPath.length < 40) {
                const cf = byId.get(id).callFrame;
                if (cf.functionName !== '(root)')
                    hottestPath.push(
                        frame(
                            cf.functionName,
                            cf.url,
                            cf.lineNumber,
                            cf.columnNumber,
                        ),
                    );
                id = parentOf.get(id);
            }
        }
        return { hottest, hottestPath };
    }

    // The main thread answers the inspector at its next interrupt check,
    // which JavaScript reaches within milliseconds. An answer slower than
    // this may have come only after the blocking code returned, so the
    // stack it carries is not trusted.
    const LATE_ANSWER_MS = 1_000;

    function pausedStack(
        session: InstanceType<typeof inspector.Session>,
        ranSinceStart: () => boolean,
    ): Promise<
        | {
              frames: ReturnType<typeof frame>[];
              recovered: boolean;
              late: boolean;
              answerMs: number;
          }
        // The inspector answered with an error: say so, never "no answer".
        | { error: string }
        // No answer within the bound.
        | null
    > {
        return new Promise((resolve) => {
            let done = false;
            let recovered = false;
            let late = false;
            let answerMs = 0;
            const askedAt = Date.now();
            // CallFrame.url is deprecated and often empty; the script's url
            // comes from the scriptParsed events Debugger.enable replays.
            const scripts = new Map<string, string>();
            const onScript = (msg: any) => {
                if (msg.params?.scriptId)
                    scripts.set(msg.params.scriptId, msg.params.url ?? '');
            };
            const finish = (
                frames: ReturnType<typeof frame>[] | null,
                error?: string,
            ) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                session.removeListener('Debugger.paused', onPaused);
                session.removeListener('Debugger.scriptParsed', onScript);
                resolve(
                    frames
                        ? { frames, recovered, late, answerMs }
                        : error
                          ? { error }
                          : null,
                );
            };
            const timer = setTimeout(() => finish(null), 5_000);
            function onPaused(msg: any) {
                // Read while the main thread is paused: if it ticked since
                // the capture began, the stall had already ended.
                recovered = ranSinceStart();
                answerMs = Date.now() - askedAt;
                late = answerMs > LATE_ANSWER_MS;
                const frames = (msg.params?.callFrames ?? [])
                    .slice(0, 40)
                    .map((f: any) =>
                        frame(
                            f.functionName,
                            f.url || scripts.get(f.location?.scriptId) || '',
                            f.location.lineNumber,
                            f.location.columnNumber ?? 0,
                        ),
                    );
                // Resume first: the main thread must never stay paused.
                session.post('Debugger.resume', () =>
                    session.post('Debugger.disable', () => finish(frames)),
                );
            }
            session.on('Debugger.scriptParsed', onScript);
            session.on('Debugger.paused', onPaused);
            session.post('Debugger.enable', (err: Error | null) => {
                if (err)
                    return finish(
                        null,
                        `Debugger.enable failed: ${err.message || String(err)}`,
                    );
                session.post('Debugger.pause', (e2: Error | null) => {
                    if (e2)
                        finish(
                            null,
                            `Debugger.pause failed: ${e2.message || String(e2)}`,
                        );
                });
            });
        });
    }

    // A stack or profile read after the main thread ticked again shows
    // whatever ran after the stall, not the stall: compare the main
    // thread's tick at the start of the capture with its tick at the
    // moment the stack is read (while it is paused) and when the profile
    // ends. Code the inspector cannot interrupt (synchronous native calls)
    // only answers once it has returned, so this is how that case shows.
    // `tickSeen` is the tick the stall was detected on: any later tick
    // means the main thread ran again.
    async function capture(tickSeen: bigint) {
        const ranSinceStart = () => Atomics.load(lastTick, 0) !== tickSeen;
        const session = new inspector.Session();
        session.connectToMainThread();
        try {
            let summary: ReturnType<typeof summarize> | null = null;
            let profileIncludesRecovery = false;
            let profileLate = false;
            let profileSlow = false;
            let profilerAnswerMs: number | undefined;
            if (cfg.profileMs > 0) {
                // How long the inspector call that failed had been waiting:
                // a call that fails (5s bound) after more than
                // LATE_ANSWER_MS means the main thread was blocked, so the
                // stack is not trusted. Only inspector calls are timed; our
                // own work (summarize) never counts.
                let failedCallMs = 0;
                const call = async (method: string, params?: object) => {
                    const sentAt = Date.now();
                    try {
                        return await post(session, method, params);
                    } catch (e) {
                        failedCallMs = Date.now() - sentAt;
                        throw e;
                    }
                };
                try {
                    const startAskedAt = Date.now();
                    await call('Profiler.enable');
                    await call('Profiler.setSamplingInterval', {
                        interval: 1_000,
                    });
                    await call('Profiler.start');
                    // Started only after the stall ended (or after code the
                    // inspector cannot interrupt returned): every sample is
                    // of what ran next, so the profile says nothing.
                    profilerAnswerMs = Date.now() - startAskedAt;
                    profileSlow = profilerAnswerMs > LATE_ANSWER_MS;
                    profileLate = profileSlow || ranSinceStart();
                    await sleep(cfg.profileMs);
                    const { profile } = await call('Profiler.stop');
                    // Started inside the stall: its samples up to the
                    // recovery still name the code (idle time is ignored).
                    profileIncludesRecovery = ranSinceStart();
                    summary = profileLate ? null : summarize(profile);
                    await post(session, 'Profiler.disable').catch(() => {});
                } catch {
                    summary = null;
                    if (failedCallMs > LATE_ANSWER_MS) profileSlow = true;
                }
            }
            const paused = await pausedStack(session, ranSinceStart);
            const pauseError =
                paused && 'error' in paused ? paused.error : undefined;
            const read = paused && !('error' in paused) ? paused : null;
            const stackUnavailable: StallReport['stackUnavailable'] =
                pauseError !== undefined
                    ? undefined // reported as the capture error instead
                    : !read
                      ? 'no-answer'
                      : read.late || profileSlow
                        ? 'answered-late'
                        : read.recovered
                          ? 'ended-before-read'
                          : undefined;
            return {
                stack:
                    read && stackUnavailable === undefined ? read.frames : null,
                ...(summary ?? {}),
                profileIncludesRecovery: !!summary && profileIncludesRecovery,
                recoveredBeforeRead: !!read?.recovered,
                stackUnavailable,
                inspectorAnswerMs: read?.answerMs,
                profilerAnswerMs,
                error: pauseError,
            };
        } finally {
            try {
                session.disconnect();
            } catch {
                // already gone
            }
        }
    }

    function emit(level: string, msg: string, report: StallReport) {
        if (cfg.writeFd !== null) {
            try {
                fs.writeSync(
                    cfg.writeFd,
                    JSON.stringify({
                        level,
                        time: new Date().toISOString(),
                        context: 'StallWatchdog',
                        ...cfg.identity,
                        metadata: { ...cfg.identity, ...report },
                        msg,
                    }) + '\n',
                );
            } catch {
                // stdout gone; nothing else to do from here
            }
        }
        try {
            parent?.postMessage(report);
        } catch {
            // main thread side closed
        }
    }

    async function heartbeat(path: '' | '/fail', body?: object) {
        if (!cfg.heartbeatUrl) return;
        try {
            await fetch(`${cfg.heartbeatUrl}${path}`, {
                method: path ? 'POST' : 'GET',
                headers: body ? { 'content-type': 'application/json' } : {},
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(10_000),
            });
        } catch {
            // alerting is best effort; the report is already in the logs
        }
    }

    // Why there is no place to name, in the words of the alert.
    const NO_PLACE: Record<string, string> = {
        'answered-late':
            'code the inspector could not interrupt in time (it answered only after more than a second: likely a synchronous native call such as execSync, a *Sync fs/zlib/crypto call or a native addon, a long regex or builtin, or a long garbage collection)',
        'no-answer':
            'code the inspector could not interrupt (no answer within the bound: likely a synchronous native call such as execSync, a *Sync fs/zlib/crypto call or a native addon)',
        'ended-before-read':
            'an unknown place (the stall ended before its stack was read)',
        'not-captured':
            'an unknown place (not captured: the watchdog was still capturing an earlier stall)',
    };

    function describe(
        stack: Array<{ fn: string; file: string; line: number }> | null,
        hottest: Array<{ fn: string; file: string; line: number }> | undefined,
        reason: string | undefined,
        error: string | undefined,
    ) {
        const top = stack?.[0];
        if (top) return `${top.fn} (${top.file}:${top.line})`;
        const hot = hottest?.[0];
        if (hot)
            return `${hot.fn} (${hot.file}:${hot.line}) per the CPU profile`;
        if (reason && Object.hasOwn(NO_PLACE, reason)) return NO_PLACE[reason];
        return `an unknown place (capture failed${error ? `: ${error}` : ''})`;
    }

    function emitRecovered(stalledMs: number) {
        emit(
            'warn',
            `Main thread recovered after a ${Math.round(stalledMs / 1000)}s stall`,
            { kind: 'recovered', stalledMs },
        );
    }

    type StallRecord = NonNullable<typeof stall>;

    // One stall report (log line, parent message) and, for the first one of
    // a stall, the BetterStack alert. Every stall gets this, captured or not.
    function reportStall(
        s: StallRecord,
        n: number,
        r: {
            stack: ReturnType<typeof frame>[] | null;
            hottest?: StallReport['hottest'];
            hottestPath?: StallFrame[];
            profileIncludesRecovery?: boolean;
            recoveredBeforeRead?: boolean;
            stackUnavailable?: StallReport['stackUnavailable'];
            inspectorAnswerMs?: number;
            profilerAnswerMs?: number;
            error?: string;
        },
    ) {
        const {
            stack,
            hottest,
            hottestPath,
            profileIncludesRecovery,
            recoveredBeforeRead,
            stackUnavailable,
            inspectorAnswerMs,
            profilerAnswerMs,
            error,
        } = r;
        // A stall that ended during the capture keeps its real length, not
        // the capture's.
        const stalledMs = s.endedMs ?? Date.now() - s.start;
        const where = describe(stack, hottest, stackUnavailable, error);
        emit(
            'error',
            `Main thread stalled for ${Math.round(stalledMs / 1000)}s in ${where}`,
            {
                kind: 'stall',
                stalledMs,
                capture: n,
                stack,
                hottest,
                hottestPath,
                location: where,
                ...(recoveredBeforeRead
                    ? { stackReadAfterRecovery: true }
                    : {}),
                ...(stackUnavailable ? { stackUnavailable } : {}),
                ...(profileIncludesRecovery
                    ? { profileIncludesRecovery: true }
                    : {}),
                ...(inspectorAnswerMs !== undefined
                    ? { inspectorAnswerMs }
                    : {}),
                ...(profilerAnswerMs !== undefined ? { profilerAnswerMs } : {}),
                ...(error !== undefined ? { error } : {}),
            },
        );
        if (n <= 1) {
            void heartbeat('/fail', {
                message: `Worker main thread stalled ${Math.round(stalledMs / 1000)}s in ${where}. ${s.endedMs !== undefined ? 'It has recovered; jobs in flight may have lost their broker connection.' : 'In-flight jobs on this worker will be lost if it does not recover.'} ${Object.entries(
                    cfg.identity,
                )
                    .map(([k, v]) => `${k}=${v}`)
                    .join(' ')}`,
                context: {
                    monitor: 'worker_stall',
                    ...cfg.identity,
                    stalledMs,
                    recovered: s.endedMs !== undefined,
                    location: where,
                    stackUnavailable,
                    stack: (stack ?? []).slice(0, 12),
                    hottest: (hottest ?? []).slice(0, 5),
                },
            });
        }
    }

    setInterval(() => {
        const now = Date.now();
        const tick = Atomics.load(lastTick, 0);
        const lag = now - Number(tick);

        if (lag >= cfg.thresholdMs) {
            if (stall === null) {
                stall = { start: now - lag, captures: 0 };
            }
            const s = stall;
            const due = cfg.thresholdMs + s.captures * cfg.recaptureMs;
            if (
                capturingFor === null &&
                s.captures < cfg.maxCapturesPerStall &&
                lag >= due
            ) {
                capturingFor = s;
                s.captures += 1;
                const n = s.captures;
                // Every stall is reported and alerted, with or without a
                // stack: a capture that fails still means a stuck worker.
                capture(tick)
                    .catch((e: Error) => ({
                        stack: null,
                        hottest: undefined,
                        hottestPath: undefined,
                        profileIncludesRecovery: false,
                        recoveredBeforeRead: false,
                        stackUnavailable:
                            undefined as StallReport['stackUnavailable'],
                        // Never empty: an empty error would read as a
                        // capture that worked and found nothing.
                        error: e.message || String(e),
                    }))
                    .then((r) => reportStall(s, n, r))
                    .finally(() => {
                        capturingFor = null;
                        // The recovery is reported after this stall's own
                        // report, never before it.
                        if (s.recoveryPending) {
                            s.recoveryPending = false;
                            emitRecovered(s.endedMs ?? Date.now() - s.start);
                        }
                    });
            }
        } else if (stall !== null) {
            // Close the stall now, even with a capture in flight: a new
            // stall must start its own record and its own captures.
            const s = stall;
            stall = null;
            s.endedMs = now - lag - s.start;
            if (capturingFor === s) s.recoveryPending = true;
            else {
                // A stall that never got a capture (the slot was busy with an
                // earlier stall's) is still a stall: report and alert it.
                if (s.captures === 0)
                    reportStall(s, 0, {
                        stack: null,
                        stackUnavailable: 'not-captured',
                    });
                emitRecovered(s.endedMs);
            }
        }

        if (
            cfg.heartbeatUrl &&
            cfg.pingIntervalMs > 0 &&
            stall === null &&
            now - lastPing >= cfg.pingIntervalMs
        ) {
            lastPing = now;
            void heartbeat('');
        }
    }, cfg.checkIntervalMs);
}

/**
 * Starts the watchdog thread and the main-thread tick it watches. Returns a
 * stop function. Never throws: a watchdog that fails to start only logs.
 */
export function startStallWatchdog(
    opts: StallWatchdogOptions = {},
    logger: WatchdogLogger = createLogger('StallWatchdog'),
): () => void {
    const cfg = {
        thresholdMs: opts.thresholdMs ?? 20_000,
        checkIntervalMs: opts.checkIntervalMs ?? 1_000,
        profileMs: opts.profileMs ?? 3_000,
        maxCapturesPerStall: opts.maxCapturesPerStall ?? 3,
        recaptureMs: opts.recaptureMs ?? 60_000,
        heartbeatUrl: opts.heartbeatUrl ?? '',
        pingIntervalMs: opts.pingIntervalMs ?? 30 * 60_000,
        identity: opts.identity ?? {},
        writeFd: opts.writeFd === undefined ? 1 : opts.writeFd,
        tickIntervalMs: opts.tickIntervalMs ?? 500,
    };

    const sab = new SharedArrayBuffer(8);
    const lastTick = new BigInt64Array(sab);
    const tick = () => Atomics.store(lastTick, 0, BigInt(Date.now()));
    tick();
    const ticker = setInterval(tick, cfg.tickIntervalMs);
    ticker.unref();

    let worker: Worker | undefined;
    try {
        worker = new Worker(`(${stallWatchdogThread.toString()})()`, {
            eval: true,
            workerData: { sab, cfg },
            resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
        worker.unref();
        worker.on('error', (error: unknown) =>
            logger.error({
                message:
                    'Stall watchdog thread failed; stalls will not be captured',
                context: 'StallWatchdog',
                error:
                    error instanceof Error ? error : new Error(String(error)),
            }),
        );
        if (opts.onReport) worker.on('message', opts.onReport);
    } catch (error) {
        clearInterval(ticker);
        logger.warn({
            message:
                'Stall watchdog could not start; stalls will not be captured',
            context: 'StallWatchdog',
            error: error instanceof Error ? error : undefined,
        });
        return () => undefined;
    }

    return () => {
        clearInterval(ticker);
        void worker?.terminate();
    };
}
