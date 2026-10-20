/**
 * One Claude Agent SDK subprocess per call, bounded per worker.
 *
 * `withSession` takes a slot in the per-worker semaphore (queued under the
 * caller's queue timeout), creates a private HOME, opens a gateway session,
 * builds the allowlisted env and runs `fn`. Whatever happens — result, error,
 * abort — it then aborts the query, kills the process if it is still alive
 * after the grace period, revokes the token and removes the directory.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ByokEnvelopeOptions } from '@libs/llm/byok-call-envelope';

import { ClaudeSdkInfraError } from './errors';
import type { GatewaySession, RequestObservation, SdkGateway } from './gateway/server';
import type { ResolvedSdkRoute } from './route';
import { buildSdkEnv, type SdkEnvOptions } from './sdk-env';

/** RSS of one subprocess, from the spike (max 211 MB on a tool loop). */
export const SUBPROCESS_RSS_BYTES = 220 * 1024 * 1024;
/** Kill a process that has not exited this long after its session was aborted. */
export const KILL_GRACE_MS = 5_000;
const DEFAULT_QUEUE_TIMEOUT_MS = 10 * 60_000;

/** Half the machine's memory for subprocesses, 2 to 32 of them. */
export function defaultPoolCapacity(totalMemBytes = os.totalmem()): number {
    return Math.max(2, Math.min(32, Math.floor((totalMemBytes * 0.5) / SUBPROCESS_RSS_BYTES)));
}

export interface SdkSessionRequest {
    resolved: ResolvedSdkRoute;
    envelope: ByokEnvelopeOptions;
    temperature?: number;
    signal?: AbortSignal;
    queueTimeoutMs?: number;
    observe?: (o: RequestObservation) => void | Promise<void>;
    env?: SdkEnvOptions;
}

export interface SdkSessionSpawnOptions {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
}

export interface SdkSession {
    model: string;
    gateway: GatewaySession;
    home: string;
    env: Record<string, string>;
    /** Pass to `query({ options: { abortController } })`. */
    abortController: AbortController;
    /** Pass to `query({ options: { spawnClaudeCodeProcess } })`: the pool tracks the process to kill it. */
    spawn: (opts: SdkSessionSpawnOptions) => ChildProcess;
}

interface Waiter {
    resolve: () => void;
    reject: (e: Error) => void;
}

export class SdkProcessPool {
    private active = 0;
    private readonly waiters: Waiter[] = [];
    private readonly live = new Set<{ abort: () => void; done: Promise<unknown> }>();
    private closed = false;

    constructor(
        private readonly gateway: SdkGateway,
        readonly capacity = defaultPoolCapacity(),
        private readonly killGraceMs = KILL_GRACE_MS,
    ) {}

    get inUse(): number {
        return this.active;
    }

    get queued(): number {
        return this.waiters.length;
    }

    private acquire(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
        if (this.closed) return Promise.reject(new ClaudeSdkInfraError('aborted', 'pool is shut down'));
        if (signal?.aborted) return Promise.reject(new ClaudeSdkInfraError('aborted', 'aborted before a subprocess slot was free'));
        if (this.active < this.capacity) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const waiter: Waiter = {
                resolve: () => {
                    cleanup();
                    resolve();
                },
                reject: (e) => {
                    cleanup();
                    reject(e);
                },
            };
            const timer = setTimeout(
                () => waiter.reject(new ClaudeSdkInfraError('queue-timeout', `no subprocess slot free within ${timeoutMs} ms (${this.capacity} in use)`)),
                timeoutMs,
            );
            const onAbort = () => waiter.reject(new ClaudeSdkInfraError('aborted', 'aborted while waiting for a subprocess slot'));
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                const i = this.waiters.indexOf(waiter);
                if (i >= 0) this.waiters.splice(i, 1);
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            this.waiters.push(waiter);
        });
    }

    private release(): void {
        const next = this.waiters.shift();
        if (next) next.resolve();
        else this.active--;
    }

    async withSession<T>(req: SdkSessionRequest, fn: (s: SdkSession) => Promise<T>): Promise<T> {
        await this.acquire(req.signal, req.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS);
        const abortController = new AbortController();
        const onCallerAbort = () => abortController.abort(req.signal?.reason);
        req.signal?.addEventListener('abort', onCallerAbort, { once: true });
        if (req.signal?.aborted) abortController.abort(req.signal.reason);

        let home: string | undefined;
        let gatewaySession: GatewaySession | undefined;
        const children = new Set<ChildProcess>();
        const killTimers = new Set<NodeJS.Timeout>();
        const killAfterGrace = (child: ChildProcess) => {
            const t = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }, this.killGraceMs);
            t.unref?.();
            killTimers.add(t);
            child.once('exit', () => {
                clearTimeout(t);
                killTimers.delete(t);
            });
        };
        abortController.signal.addEventListener('abort', () => children.forEach(killAfterGrace), { once: true });

        let settle!: () => void;
        const entry = { abort: () => abortController.abort(new Error('worker shutting down')), done: new Promise<void>((r) => (settle = r)) };
        this.live.add(entry);
        try {
            home = await mkdtemp(path.join(os.tmpdir(), 'kodus-claude-sdk-'));
            gatewaySession = await this.gateway.openSession({
                route: req.resolved.route,
                envelope: req.envelope,
                temperature: req.temperature,
                signal: abortController.signal,
                observe: req.observe,
            });
            const env = buildSdkEnv(req.resolved.route, { baseUrl: gatewaySession.baseUrl, token: gatewaySession.token, home }, req.env);
            const sessionHome = home;
            const spawnTracked = (o: SdkSessionSpawnOptions): ChildProcess => {
                const child = spawn(o.command, o.args, { cwd: o.cwd ?? sessionHome, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
                children.add(child);
                child.once('exit', () => children.delete(child));
                o.signal.addEventListener('abort', () => killAfterGrace(child), { once: true });
                if (abortController.signal.aborted) killAfterGrace(child);
                return child;
            };
            return await fn({ model: req.resolved.model, gateway: gatewaySession, home, env, abortController, spawn: spawnTracked });
        } finally {
            if (!abortController.signal.aborted) abortController.abort(new Error('session ended'));
            req.signal?.removeEventListener('abort', onCallerAbort);
            // Wait for the processes to go (they get the grace period, then SIGKILL).
            await Promise.all([...children].map((c) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', () => r())))));
            killTimers.forEach(clearTimeout);
            gatewaySession?.close();
            if (home) await rm(home, { recursive: true, force: true });
            this.live.delete(entry);
            settle();
            this.release();
        }
    }

    /** Aborts every live session, rejects the queue, and waits for cleanup. */
    async shutdown(): Promise<void> {
        this.closed = true;
        for (const w of [...this.waiters]) w.reject(new ClaudeSdkInfraError('aborted', 'pool is shut down'));
        const pending = [...this.live];
        pending.forEach((e) => e.abort());
        await Promise.all(pending.map((e) => e.done));
    }
}
