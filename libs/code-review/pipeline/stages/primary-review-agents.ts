/** The review's primary agents. Kody Rules and custom agents are auxiliary. */
export const PRIMARY_REVIEW_AGENTS: ReadonlySet<string> = new Set([
    'generalist',
    'bug',
    'security',
    'performance',
]);

export const isPrimaryReviewAgent = (agentName?: string): boolean =>
    !!agentName && PRIMARY_REVIEW_AGENTS.has(agentName);
