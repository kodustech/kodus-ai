/**
 * One Langfuse generation per upstream request of an SDK call, under the
 * caller's trace — where the AI SDK path records one per step through its
 * telemetry. The gateway serves requests outside the call's async context, so
 * the context is captured when the call starts and restored per request.
 */
import { context } from '@opentelemetry/api';
import { startObservation } from '@langfuse/tracing';

import { shouldTrace, type LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';

import type { RequestObservation } from './gateway/server';

export function langfuseRequestObserver(
    runName: string,
    metadata: LangfuseTelemetryMetadata | undefined,
): ((o: RequestObservation) => void) | undefined {
    if (!shouldTrace()) return undefined;
    const captured = context.active();
    const tags = Object.fromEntries(Object.entries({ ...metadata, runtime: 'claude-agent-sdk' }).filter(([, v]) => v !== undefined && v !== ''));
    return (o) =>
        context.with(captured, () => {
            const generation = startObservation(
                runName,
                {
                    model: o.model,
                    input: o.input,
                    output: o.output,
                    ...(o.usage
                        ? {
                              usageDetails: {
                                  input: o.usage.inputTokens - o.usage.cacheReadTokens - o.usage.cacheWriteTokens,
                                  output: o.usage.outputTokens,
                                  cache_read_input_tokens: o.usage.cacheReadTokens,
                                  cache_creation_input_tokens: o.usage.cacheWriteTokens,
                              },
                          }
                        : {}),
                    metadata: { ...tags, status: o.status, ms: o.ms, ...(o.compaction ? { compaction: o.compaction } : {}) },
                    ...(o.status >= 400 ? { level: 'ERROR' as const } : {}),
                },
                { asType: 'generation' },
            );
            generation.end();
        });
}
