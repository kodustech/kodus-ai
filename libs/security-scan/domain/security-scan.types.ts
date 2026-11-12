import type { VulnClass } from './surface/surface.types';

export enum SecurityScanStatus {
    QUEUED = 'queued',
    RUNNING = 'running',
    /** Every unit was examined. */
    COMPLETED = 'completed',
    /** Stopped before the end because the spend cap was reached. */
    STOPPED_BY_BUDGET = 'stopped_by_budget',
    FAILED = 'failed',
}

/**
 * What the customer agreed to spend on one scan. USD when the model has a
 * known price; tokens otherwise (an `openai_compatible` model nobody priced).
 */
export interface SecurityScanBudget {
    maxUsd?: number;
    maxTokens?: number;
}

export interface SecurityScanSpend {
    usd: number;
    inputTokens: number;
    outputTokens: number;
    requests: number;
}

/**
 * One piece of the repository the lenses examine together: a file the map
 * marked as reachable from outside or holding a dangerous operation, plus the
 * files the map tied to it.
 */
export interface ScanUnit {
    id: string;
    /** The file the unit is about; findings may land in `relatedFiles` too. */
    file: string;
    relatedFiles: string[];
    language: string;
    classes: VulnClass[];
    /** Higher runs first; the budget may never reach the tail. */
    priority: number;
    /** Why the map picked it: the heuristic hits, or the model's note. */
    reasons: string[];
}

export type ScanUnitState = 'pending' | 'done' | 'failed' | 'skipped_budget';

export interface ScanUnitProgress {
    unitId: string;
    state: ScanUnitState;
    findings: number;
    error?: string;
    /**
     * On a unit a slice left pending: the classes whose lens already ended,
     * and of those, the ones read to the end. The next slice runs only the
     * rest, so a unit longer than a slice still gets through.
     */
    lensesRun?: VulnClass[];
    lensesExamined?: VulnClass[];
}

export interface SecurityScanOutcomeCounts {
    created: number;
    stillOpen: number;
    reopened: number;
    dismissed: number;
    resolved: number;
}

/** The files a lens of one class read to the end. */
export interface ScanExaminedClass {
    vulnerabilityClass: VulnClass;
    filePaths: string[];
}

export interface SecurityScanCoverage {
    /** Files at least one lens examined in this scan. */
    examinedFiles: string[];
    /**
     * Per class, what this scan examined: only these findings may be
     * resolved for not being seen again. Absent on scans before it existed.
     */
    examinedByClass?: ScanExaminedClass[];
    unitsTotal: number;
    unitsDone: number;
    unitsFailed: number;
    unitsSkippedByBudget: number;
    /** Languages the repository holds and how the map handled them. */
    languages: string[];
    /**
     * What the plan could not hold, so a completed scan is not read as full
     * coverage: languages whose pattern search failed, and candidate files
     * past the plan's limit.
     */
    mapFailedLanguages?: string[];
    filesBeyondPlan?: number;
}

export interface SecurityScanRecord {
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
    spend: SecurityScanSpend;
    /** The commit scanned; set once the sandbox has the repository. */
    commitSha?: string;
    /**
     * The commit an inherited plan was made at, on a scan that carries on
     * where an earlier one stopped: dropped if the branch has moved since.
     */
    planCommitSha?: string;
    units: ScanUnit[];
    progress: ScanUnitProgress[];
    /** What the scan reported so far, so a continuation does not report it again. */
    reported?: ScanReportedFinding[];
    coverage?: SecurityScanCoverage;
    outcome?: SecurityScanOutcomeCounts;
    /** Model the scan ran on, as `provider:model`. */
    modelName?: string;
    requestedBy?: { userId?: string; email?: string };
    error?: string;
    startedAt?: string;
    finishedAt?: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * A finding the engine confirmed, before it becomes a Kody Issue. Independent
 * of persistence so the eval scores exactly what production would store.
 */
export interface ScanFinding {
    unitId: string;
    vulnerabilityClass: VulnClass;
    cwe?: string;
    title: string;
    description: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
    symbol?: string;
    attackPath: { file: string; line: number; note: string }[];
    suggestedFix?: string;
    /** One setting the whole application shares, not this place's own bug. */
    appWide?: boolean;
    reproduction?: {
        path: string;
        content: string;
        command: string;
        executed: boolean;
        exitCode?: number;
        reproduced?: boolean;
        output?: string;
    };
}

/** The part of a reported finding the dedup compares a new one against. */
export type ScanReportedFinding = Pick<
    ScanFinding,
    | 'vulnerabilityClass'
    | 'cwe'
    | 'title'
    | 'description'
    | 'severity'
    | 'filePath'
    | 'startLine'
    | 'endLine'
> &
    Partial<Pick<ScanFinding, 'attackPath'>> & {
        /** The issue it was stored as: a scan carrying it on sights it too. */
        fingerprint?: string;
    };
