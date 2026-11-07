/**
 * code-review (domain) — wraps a review agent run in a Langfuse trace span.
 *
 * Usage/cost accounting is NOT here: `LLM.run` records the ONE cost span per
 * leaf model call (finder / verify / resample / prose-recovery), each carrying a
 * `code-review-*` runName so `deriveArea` buckets it to `review`. This file owns
 * only the Langfuse trace grouping (session by org:repo:pr). Best-effort: any
 * failure is swallowed (observability must never break a review).
 */
import { propagateAttributes, startActiveObservation } from '@langfuse/tracing';
import { pullRequestSessionId, shouldTrace } from '@libs/core/log/langfuse';
import { createLogger } from '@libs/core/log/logger';

const logger = createLogger('ReviewObservability');

export interface AgentTraceMeta {
    traceName: string;
    organizationId?: string;
    teamId?: string;
    prNumber?: number;
    repositoryId?: string;
}

/**
 * Run `fn` inside a Langfuse trace span (session grouped by org:repo:pr).
 * No-op passthrough when tracing is disabled. `spanInput` is the sanitized
 * input recorded on the span (caller strips secrets / large diffs).
 */
export async function runAgentWithTrace<T>(
    meta: AgentTraceMeta,
    spanInput: unknown,
    fn: () => Promise<T>,
): Promise<T> {
    if (!shouldTrace()) {
        return fn();
    }

    const traceMetadata: Record<string, string> = {};
    traceMetadata.organizationId = meta.organizationId || 'unknown_org';
    traceMetadata.teamId = meta.teamId || 'unknown_team';
    if (meta.prNumber) {
        traceMetadata.prNumber = String(meta.prNumber);
        traceMetadata.pullRequestId = String(meta.prNumber);
    }
    if (meta.repositoryId) {
        traceMetadata.repositoryId = meta.repositoryId;
    }

    return propagateAttributes(
        {
            traceName: meta.traceName,
            // Shared derivation: the business-rules agent must land in THIS
            // session, which only happens if both spell the key identically.
            sessionId: pullRequestSessionId({
                organizationId: traceMetadata.organizationId,
                repositoryId: traceMetadata.repositoryId,
                pullRequestId: traceMetadata.prNumber,
            }),
            userId: traceMetadata.organizationId,
            metadata: traceMetadata,
        },
        () =>
            startActiveObservation(meta.traceName, async (span: any) => {
                safeSpanUpdate(span, { input: spanInput }, meta);
                const result = await fn();
                safeSpanUpdate(span, { output: result }, meta);
                return result;
            }),
    );
}

/** A span update that cannot throw: the trace loses a field, the review runs. */
function safeSpanUpdate(
    span: { update: (arg: unknown) => unknown },
    arg: Record<string, unknown>,
    meta: AgentTraceMeta,
): void {
    try {
        span.update(arg);
    } catch (error) {
        logger.warn({
            message: `Langfuse span update failed for ${meta.traceName}; review continues without it`,
            error,
            context: 'ReviewObservability',
            metadata: {
                field: Object.keys(arg)[0],
                organizationId: meta.organizationId,
                prNumber: meta.prNumber,
            },
        });
    }
}
