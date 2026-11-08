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
        logger.warn({
            message: 'Usage meter failed to record a model request',
            context: 'UsageMeter',
            error,
            metadata: {
                ...store.context,
                runName: meta.runName,
                modelName: meta.modelName,
            },
        });
    }
}
