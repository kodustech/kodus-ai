import { AsyncLocalStorage } from 'node:async_hooks';

import { readAiSdkUsage, type AiSdkUsage, type AiSdkUsageInput } from './ai-sdk-usage';
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

const meterStore = new AsyncLocalStorage<UsageMeter>();

/** Every model request made inside `fn` (and what it awaits) is reported to `meter`. */
export function runWithUsageMeter<T>(
    meter: UsageMeter,
    fn: () => Promise<T>,
): Promise<T> {
    return meterStore.run(meter, fn);
}

/**
 * Called by the LLM layer after each answered request. A meter that throws
 * never breaks the call it observes.
 */
export function reportUsage(
    usage: AiSdkUsageInput,
    meta: Omit<UsageObservation, 'usage'>,
): void {
    const meter = meterStore.getStore();
    if (!meter) {
        return;
    }
    try {
        meter.record({ usage: readAiSdkUsage(usage), ...meta });
    } catch (error) {
        logger.warn({
            message: 'Usage meter failed to record a model request',
            context: 'UsageMeter',
            error,
            metadata: { runName: meta.runName, modelName: meta.modelName },
        });
    }
}
