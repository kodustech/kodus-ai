import { AsyncLocalStorage } from 'node:async_hooks';

import {
    readAiSdkUsage,
    readAiSdkUsageFromError,
    type AiSdkUsage,
    type AiSdkUsageInput,
} from './ai-sdk-usage';
import { createLogger } from '@libs/core/log/logger';

const logger = createLogger('UsageMeter');

/** One answered model request: a loop step, or a whole one-shot call. */
export interface UsageObservation {
    usage: AiSdkUsage;
    /** `provider:model` as the call ran it (a fallback reports its own). */
    modelName?: string;
    runName?: string;
}

/**
 * Something that wants to know, as it happens, what the model calls inside a
 * piece of work cost. The span pipeline records the same usage, but only once
 * a whole call settles and only into storage — too late for a caller that has
 * to stop spending mid-run (a security scan with a spend cap).
 */
export interface UsageMeter {
    record(observation: UsageObservation): void;
    /**
     * Before a request leaves, with the most it can use. Throwing (or
     * rejecting) refuses the request; a promise holds it until there is room,
     * as when requests in flight still hold what they reserved. `record`
     * still follows for an answered request, from the caller that reads its
     * usage.
     */
    admit?(request: RequestCeiling): Admission | Promise<Admission>;
}

/** A request let through. */
export interface Admission {
    /**
     * Called once it ends: with what the provider billed for it, or
     * undefined when it provably never reached the provider, or the provider
     * refused it with an error status. Anything else that may have been
     * billed (an answer with no totals, a connection lost after sending)
     * settles with the unknown totals undefined, never as undefined: a cap
     * must not count it as free.
     */
    settle: (answered: AiSdkUsage | undefined) => void;
    /**
     * The answer cap it was admitted at, for a request that set none: sent
     * with it, so the provider cannot answer past what was reserved.
     */
    maxOutputTokens?: number;
}

/** The most one request can use, known before it leaves. */
export interface RequestCeiling {
    /** Its prompt and tool definitions, counted with the shared tokenizer. */
    inputTokens: number;
    /**
     * A count no model's tokenizer can exceed for the same prompt: every
     * token of a byte-level tokenizer is at least one byte, so the UTF-8 size
     * of what is sent bounds it, plus what the provider frames it with. A
     * shared tokenizer's count can fall short of the served model's.
     */
    inputTokensUpperBound?: number;
    /** The cap the request puts on the answer, when it sets one. */
    maxOutputTokens?: number;
    /**
     * A reasoning budget the provider grants on top of the answer cap
     * (Anthropic's thinking: the SDK sends max_tokens = cap + budget).
     */
    reasoningBudgetTokens?: number;
}

/** Who installed a meter, on the warning a failing meter logs. */
export interface UsageMeterContext {
    organizationId?: string;
    teamId?: string;
    [key: string]: unknown;
}

const meterStore = new AsyncLocalStorage<{
    meter: UsageMeter;
    context?: UsageMeterContext;
}>();

/** Every model request made inside `fn` (and what it awaits) is reported to `meter`. */
export function runWithUsageMeter<T>(
    meter: UsageMeter,
    fn: () => Promise<T>,
    context?: UsageMeterContext,
): Promise<T> {
    return meterStore.run({ meter, context }, fn);
}

/**
 * Called by the LLM layer after each answered request. A meter that throws
 * never breaks the call it observes.
 */
export function reportUsage(
    usage: AiSdkUsageInput,
    meta: Omit<UsageObservation, 'usage'>,
): void {
    record(readAiSdkUsage(usage), meta);
}

const ADMITTED_UNMETERED: Admission = { settle: () => undefined };

/** Whether the run this code is in admits its requests (a spend cap). */
export function meterAdmitsRequests(): boolean {
    return !!meterStore.getStore()?.meter.admit;
}

/**
 * Called by the model wrapper before each request leaves. Outside a metered
 * run, or with a meter that does not admit, the ceiling is never computed. A
 * refusal is thrown to the caller; a meter that fails to settle never breaks
 * the call it observes.
 */
export async function admitRequest(
    ceiling: () => RequestCeiling,
    /** Aborting while the request waits for room rejects with its reason. */
    signal?: AbortSignal,
): Promise<Admission> {
    const store = meterStore.getStore();
    if (!store?.meter.admit) {
        return ADMITTED_UNMETERED;
    }
    // A caller that already gave up takes no room, not even for a moment.
    if (signal?.aborted) {
        throw signal.reason;
    }
    const admission = await untilAborted(store.meter.admit(ceiling()), signal);
    return {
        maxOutputTokens: admission.maxOutputTokens,
        settle: (answered) => {
            try {
                admission.settle(answered);
            } catch (error) {
                warnMeterFailure(store, undefined, error);
            }
        },
    };
}

/**
 * The admission, or the signal's reason if it aborts first. A room granted
 * after the caller gave up is given back at once, never held unsettled.
 */
function untilAborted(
    admission: Admission | Promise<Admission>,
    signal?: AbortSignal,
): Admission | Promise<Admission> {
    if (!signal || !(admission instanceof Promise)) {
        return admission;
    }
    if (signal.aborted) {
        admission.then((a) => a.settle(undefined)).catch(() => undefined);
        return Promise.reject(signal.reason);
    }
    return new Promise<Admission>((resolve, reject) => {
        const onAbort = () => {
            admission.then((a) => a.settle(undefined)).catch(() => undefined);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        admission.then(
            (a) => {
                signal.removeEventListener('abort', onAbort);
                if (signal.aborted) {
                    return;
                }
                resolve(a);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

/** A request that failed after the provider answered it (a bad parse) was billed. */
export function reportUsageFromError(
    error: unknown,
    meta: Omit<UsageObservation, 'usage'>,
): void {
    const billed = readAiSdkUsageFromError(error);
    if (billed) {
        record(billed.usage, meta);
    }
}

/** Runs one extra request (a repair re-ask) and reports what it was billed. */
export async function meteredRequest<T>(
    request: () => Promise<T>,
    modelName: string | undefined,
    runName: string,
): Promise<T> {
    try {
        const result = await request();
        reportUsage((result as any)?.usage, { modelName, runName });
        return result;
    } catch (error) {
        reportUsageFromError(error, { modelName, runName });
        throw error;
    }
}

function record(usage: AiSdkUsage, meta: Omit<UsageObservation, 'usage'>) {
    const store = meterStore.getStore();
    if (!store) {
        return;
    }
    try {
        store.meter.record({ usage, ...meta });
    } catch (error) {
        warnMeterFailure(store, meta.runName, error);
    }
}

function warnMeterFailure(
    store: { context?: UsageMeterContext },
    runName: string | undefined,
    error: unknown,
) {
    // Only named ids and the error's kind: the context is free-form and an
    // error's text can carry a provider payload.
    logger.warn({
        message: 'Usage meter failed to record a model request',
        context: 'UsageMeter',
        metadata: {
            organizationId: store.context?.organizationId,
            teamId: store.context?.teamId,
            repositoryId: store.context?.repositoryId,
            runName,
            errorName: error instanceof Error ? error.name : typeof error,
        },
    });
}
