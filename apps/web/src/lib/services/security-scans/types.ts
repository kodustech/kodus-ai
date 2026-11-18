export type SecurityScanStatus =
    "queued" | "running" | "completed" | "stopped_by_budget" | "failed";

export type SecurityScanBudget = {
    maxUsd?: number;
    maxTokens?: number;
};

export type SecurityScan = {
    uuid: string;
    organizationId: string;
    teamId: string;
    repository: {
        id: string;
        name: string;
        fullName: string;
        platform: string;
        defaultBranch: string;
    };
    status: SecurityScanStatus;
    budget: SecurityScanBudget;
    spend: {
        usd: number;
        inputTokens: number;
        outputTokens: number;
        requests: number;
    };
    commitSha?: string;
    coverage?: {
        examinedFiles: string[];
        unitsTotal: number;
        unitsDone: number;
        unitsFailed: number;
        unitsSkippedByBudget: number;
        languages: string[];
        /** Languages whose pattern search failed: the plan may miss their files. */
        mapFailedLanguages?: string[];
        /** Candidate files past the plan's limit, never read by this scan. */
        filesBeyondPlan?: number;
    };
    outcome?: {
        created: number;
        stillOpen: number;
        reopened: number;
        dismissed: number;
        resolved: number;
    };
    modelName?: string;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
    createdAt: string;
    updatedAt: string;
};

export type StartSecurityScanPayload = {
    teamId: string;
    /** Git provider repository id, the same as `issue.repository.id`. */
    repositoryId: string;
} & SecurityScanBudget;

export const isSecurityScanActive = (scan: Pick<SecurityScan, "status">) =>
    scan.status === "queued" || scan.status === "running";
