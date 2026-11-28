import { LlmErrorCategory } from '@libs/llm/error-classifier';

/** The review's primary agents. Kody Rules and custom agents are auxiliary. */
export const PRIMARY_REVIEW_AGENTS: ReadonlySet<string> = new Set([
    'generalist',
    'bug',
    'security',
    'performance',
]);

export const isPrimaryReviewAgent = (agentName?: string): boolean =>
    !!agentName && PRIMARY_REVIEW_AGENTS.has(agentName);

interface RecordedError {
    severity?: string;
    metadata?: Record<string, unknown>;
}

/**
 * The primary reviewers a partial run's notice names. Two primary agents on
 * one exhausted key are both recorded partial with QUOTA_EXCEEDED; naming
 * only the first would imply the other reviewed the PR. They share the
 * reason on lastReviewError, so they are named together only when that
 * error is theirs. Any other shape keeps the single attributed agent.
 */
export const failedPrimaryReviewers = (
    lastErrorAgentName: string | undefined,
    errors: readonly RecordedError[] | undefined,
): string | string[] | undefined => {
    if (!isPrimaryReviewAgent(lastErrorAgentName)) {
        return lastErrorAgentName;
    }
    const outOfQuota = [
        ...new Set(
            (errors ?? [])
                .filter(
                    (e) =>
                        e.severity === 'partial' &&
                        e.metadata?.errorCategory ===
                            LlmErrorCategory.QUOTA_EXCEEDED,
                )
                .map((e) => e.metadata?.agentName)
                .filter(
                    (name): name is string =>
                        typeof name === 'string' && isPrimaryReviewAgent(name),
                ),
        ),
    ];
    if (outOfQuota.length < 2 || !outOfQuota.includes(lastErrorAgentName)) {
        return lastErrorAgentName;
    }
    return [
        lastErrorAgentName,
        ...outOfQuota.filter((name) => name !== lastErrorAgentName),
    ];
};
