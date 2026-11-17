/**
 * Heavy mode's lenses as the PR timeline shows them: one "Specialist Agents"
 * entry per review, listing each lens. Built from how each lens ended and from
 * the findings of each that survived verify.
 */
import { classifyLLMError } from '@libs/llm/error-classifier';

import type { HeavyLensOutcome } from '@libs/code-review/infrastructure/agents/core/finder.agent';
import type { SpecialistAgentEntry } from '@libs/code-review/infrastructure/agents/review-agent.contract';
import { providerErrorFromResult } from './provider-error';

/** The progress category the specialists report under. */
export const SPECIALISTS_CATEGORY = 'specialists';

export function runningSpecialists(
    labels: string[],
    batchIndex?: number,
): SpecialistAgentEntry[] {
    return labels.map((label) => ({
        label,
        status: 'running',
        ...(batchIndex && { batchIndex }),
    }));
}

export function finishedSpecialists(
    outcomes: HeavyLensOutcome[],
    keptByLens: Record<string, number>,
    batchIndex?: number,
    provider?: string,
): SpecialistAgentEntry[] {
    return outcomes.map((o) => ({
        label: o.label,
        status: o.status,
        ...(batchIndex && { batchIndex }),
        found: o.found,
        kept: keptByLens[o.label] ?? 0,
        durationMs: o.ms,
        steps: o.steps,
        toolCalls: o.toolCalls,
        ...(o.status === 'failed' && { error: lensErrorText(o, provider) }),
        ...(o.status === 'no-result' && {
            error: `Stopped after ${o.steps} steps without submitting a result`,
        }),
    }));
}

function lensErrorText(o: HeavyLensOutcome, provider?: string): string {
    const error = providerErrorFromResult({
        finishReason: 'error',
        errorMessage: o.error?.message,
        errorName: o.error?.name,
        errorStatus: o.error?.status,
        errorResponseBody: o.error?.responseBody,
    });
    // Only the classified sentence: the provider's raw text can carry anything
    // it echoed back, and this lands in the dashboard.
    return classifyLLMError(error, provider).friendlyMessage || 'Failed';
}

/** Findings the lenses kept, to take out of the generalist's own count. */
export function keptByLensTotal(keptByLens: Record<string, number>): number {
    return Object.values(keptByLens).reduce((sum, n) => sum + n, 0);
}
