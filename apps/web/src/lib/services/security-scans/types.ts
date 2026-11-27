export type SecurityScanStatus =
    | "queued"
    | "running"
    | "completed"
    | "stopped_by_budget"
    | "failed"
    | "cancelled";

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
        /** Incremental: files left out because nothing they read changed. */
        unchangedFiles?: number;
    };
    outcome?: {
        created: number;
        stillOpen: number;
        reopened: number;
        dismissed: number;
        resolved: number;
        /** Findings the independent check refuted: never reported. */
        refuted?: number;
        /** Open issues folded into another with the same root cause. */
        consolidated?: number;
    };
    modelName?: string;
    /** The model picked for this scan; the Deep scan routing's when unset. */
    modelId?: string;
    mode?: SecurityScanMode;
    scheduleId?: string;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
    createdAt: string;
    updatedAt: string;
};

/** incremental: only what changed since earlier scans; full: everything again. */
export type SecurityScanMode = "incremental" | "full";

export type StartSecurityScanPayload = {
    teamId: string;
    /** Git provider repository id, the same as `issue.repository.id`. */
    repositoryId: string;
    mode?: SecurityScanMode;
    modelId?: string;
} & SecurityScanBudget;

export type ScanCadence = "daily" | "weekly";

export type SecurityScanSchedule = {
    uuid: string;
    teamId: string;
    repository: { platform: string; host: string; id: string };
    cadence: ScanCadence;
    budget: SecurityScanBudget;
    mode: SecurityScanMode;
    modelId?: string;
    enabled: boolean;
    nextRunAt: string;
    lastRunAt?: string;
    lastScanId?: string;
    lastError?: string;
};

export type SaveScanSchedulePayload = {
    teamId: string;
    repositoryId: string;
    cadence: ScanCadence;
    mode?: SecurityScanMode;
    modelId?: string;
    enabled?: boolean;
} & SecurityScanBudget;

export const isSecurityScanActive = (scan: Pick<SecurityScan, "status">) =>
    scan.status === "queued" || scan.status === "running";
