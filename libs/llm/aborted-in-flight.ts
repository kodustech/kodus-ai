import { wasAbortedBeforeSlot } from '@libs/llm/byok-limiter';
import { estimateTextTokens } from '@libs/llm/token-estimate';

/**
 * Span attributes for a call aborted while a request was in flight (#2389).
 * The provider never answered that request, so there is no usage to record;
 * its input is estimated so the gap is known and can be counted. Kept out of
 * the usage fields: an estimate is never billed.
 *
 * Undefined unless the call's own signal was aborted with a request out: not
 * for another failure, and not when the abort caught the call still queued in
 * the BYOK limiter, where no request had left. The prompt is read and
 * tokenized only then, never on the hot path.
 */
export function abortedInFlightAttrs(
    signal: AbortSignal | undefined,
    prompt: () => unknown,
): Record<string, unknown> | undefined {
    if (!signal?.aborted || wasAbortedBeforeSlot(signal)) return undefined;
    const input = prompt();
    if (input == null) return undefined;
    const tokens = estimateTextTokens(
        typeof input === 'string' ? input : safeStringify(input),
    );
    if (!tokens) return undefined;
    return {
        abortedInFlight: true,
        abortedInFlightInputTokensEstimate: tokens,
    };
}

/** JSON for the estimate; a value that will not serialize counts as empty. */
function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        return '';
    }
}
