import { MAX_HEALTH_TIMEOUT_SECONDS } from '@libs/runtime/blockers/catalog';
import { type EnvironmentRuntime, isEnvError } from '@libs/runtime/environment';
import type { Probe } from '@libs/runtime/probe';

// The ready check (§6): GET the health path on the public http service until it
// answers under 500. A setup runs it once its claim is ready; a Run runs it after
// every machine.reset, because the reset takes the project down and compose up
// does not wait for the app to listen again.

/** The wait when the recipe sets no services.compose.health_timeout (as reproduction.ts). */
export const DEFAULT_HEALTH_TIMEOUT_SECONDS = 120;
/** Between two tries of the ready check. */
export const HEALTH_RETRY_INTERVAL_SECONDS = 5;
/**
 * After a reset in a Run, the same 5xx this many tries in a row (~25 s) means
 * the app is up and answers that error: the behavior to measure, not a start
 * that is still under way. Without it, a PR that breaks the health path itself
 * (kr-grafana #4: /api/health 503) waits out the whole timeout every round and
 * is never compared.
 */
export const STABLE_ERROR_TRIES = 6;
/** The health path when the recipe names none and the worker sets no RUNTIME_SETUP_HEALTH_PATH. */
export const DEFAULT_HEALTH_PATH = '/health';

export interface ReadyTarget {
    service: string;
    port: number;
    path: string;
    /** How long the check waits for the app, in seconds: the recipe's health_timeout, bounded. */
    waitSeconds: number;
}

type ProbeOutcome = Awaited<ReturnType<EnvironmentRuntime['probe']>>;

/** The recipe's health_timeout as the check waits it: unset is the default, never past MAX_HEALTH_TIMEOUT_SECONDS. */
export function readyWaitSeconds(healthTimeoutSeconds: number | undefined): number {
    return Math.min(Math.max(0, healthTimeoutSeconds ?? DEFAULT_HEALTH_TIMEOUT_SECONDS), MAX_HEALTH_TIMEOUT_SECONDS);
}

/**
 * What the ready check calls: the public http service of the recipe, else the
 * first http one. Undefined when nothing is http (a worker-only or database
 * environment): there is nothing to ask.
 */
export function readyTarget(
    expose: readonly { service: string; port: number; kind: string }[],
    recipe: { public?: string; health?: string; healthTimeoutSeconds?: number },
    defaultPath?: string,
): ReadyTarget | undefined {
    const http = expose.find((e) => e.kind === 'http' && (!recipe.public || e.service === recipe.public)) ?? expose.find((e) => e.kind === 'http');
    if (!http) return undefined;
    return { service: http.service, port: http.port, path: recipe.health ?? defaultPath ?? DEFAULT_HEALTH_PATH, waitSeconds: readyWaitSeconds(recipe.healthTimeoutSeconds) };
}

/** The observer probe of one try. */
export function readyProbe(target: Pick<ReadyTarget, 'service' | 'port' | 'path'>, who: { id: string; purpose: string }): Probe {
    return {
        id: who.id,
        origin: 'external',
        purpose: who.purpose,
        expected: 'an HTTP response',
        compare: ['status'],
        spec: { kind: 'http', target: { service: target.service, port: target.port }, method: 'GET', path: target.path, timeoutMs: 30_000 },
    };
}

/** The app has not answered yet: nothing listens (the observer cannot reach it) or it answers 5xx while it starts. */
export function notAnsweringYet(out: ProbeOutcome): boolean {
    if (isEnvError(out)) return out.code === 'vm_unhealthy';
    const status = out.http?.status;
    return !status || status >= 500;
}

/** Answered under 500. */
export function answered(out: ProbeOutcome | undefined): boolean {
    if (out === undefined || isEnvError(out)) return false;
    const status = out.http?.status;
    return !!status && status < 500;
}

export interface ReadyWaitResult {
    ready: boolean;
    tries: number;
    waitedMs: number;
    last?: ProbeOutcome;
    /** Ready because the app answered this same 5xx STABLE_ERROR_TRIES times in a row (acceptStableError only). */
    stableError?: number;
}

/**
 * Asks until the app answers or `waitMs` passes on the clock (a try that hangs
 * to its own timeout uses up the wait too). For a caller already inside one
 * durable step (a Run's replay round): the whole wait is that step, so a
 * resumed workflow reads its result and never asks again.
 */
export async function waitUntilReady(args: {
    env: Pick<EnvironmentRuntime, 'probe'>;
    claimId: string;
    target: ReadyTarget;
    who: { id: string; purpose: string };
    /** The stepId of try i: stable across a retried step. */
    stepIdOf: (i: number) => string;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    /**
     * A Run's replay: an app that keeps answering the same 5xx is up, and that
     * answer is what the round measures. A setup never sets it: there a stable
     * 5xx on the default branch is a boot that failed.
     */
    acceptStableError?: boolean;
}): Promise<ReadyWaitResult> {
    const { env, claimId, target } = args;
    const waitMs = target.waitSeconds * 1_000;
    const interval = HEALTH_RETRY_INTERVAL_SECONDS * 1_000;
    const startedAt = args.now();
    const probe = readyProbe(target, args.who);
    let last: ProbeOutcome | undefined;
    let tries = 0;
    let same = 0;
    let previous: number | undefined;
    let stableError: number | undefined;
    for (;;) {
        last = await env.probe(claimId, probe, args.stepIdOf(tries));
        tries++;
        if (!notAnsweringYet(last)) break;
        const status = isEnvError(last) ? undefined : last.http?.status;
        same = status !== undefined && status === previous ? same + 1 : status !== undefined ? 1 : 0;
        previous = status;
        if (args.acceptStableError && status !== undefined && same >= STABLE_ERROR_TRIES) {
            stableError = status;
            break;
        }
        if (args.now() + interval - startedAt >= waitMs) break;
        await args.sleep(interval);
    }
    return {
        ready: answered(last) || stableError !== undefined,
        tries,
        waitedMs: args.now() - startedAt,
        last,
        ...(stableError !== undefined ? { stableError } : {}),
    };
}
