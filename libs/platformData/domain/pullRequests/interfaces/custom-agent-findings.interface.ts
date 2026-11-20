/**
 * Stored findings of a custom agent sharing a pull request and statuses, as
 * the custom agents status reads them. `count` defaults to one finding.
 */
export type CustomAgentSuggestionRow = {
    agentId: string;
    prNumber: number;
    deliveryStatus?: string;
    priorityStatus?: string;
    count?: number;
};

/** Dropped findings of an agent that cited one file without following it. */
export type UnfollowedCitationRow = {
    agentId: string;
    reason: string;
    findings: number;
    prNumbers: number[];
};

/** One repository's pull requests updated since `since`. */
export type CustomAgentFindingsScope = {
    organizationId: string;
    repositoryId: string;
    since: Date;
};
