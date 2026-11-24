import { OrganizationAndTeamData } from '../../config/types/general/organizationAndTeamData';

export enum CheckStatus {
    QUEUED = 'QUEUED',
    IN_PROGRESS = 'IN_PROGRESS',
    COMPLETED = 'COMPLETED',
}

export enum CheckConclusion {
    SUCCESS = 'SUCCESS',
    FAILURE = 'FAILURE',
    NEUTRAL = 'NEUTRAL',
    SKIPPED = 'SKIPPED',
    ACTION_REQUIRED = 'ACTION_REQUIRED',
    CANCELLED = 'CANCELLED',
    TIMED_OUT = 'TIMED_OUT',
}

/**
 * A completed check whose conclusion is missing or not one of
 * `CheckConclusion`. Adapters throw it before calling the platform instead
 * of falling back to a passing state (ADR-052, fail-closed of ADR-020).
 */
export class UnknownCheckConclusionError extends Error {
    constructor(readonly conclusion: unknown) {
        super(`unknown check conclusion: ${String(conclusion)}`);
        this.name = 'UnknownCheckConclusionError';
    }
}

// Single stable check-run name for every code review execution. The platform
// groups check runs by (name, head_sha) and only surfaces the most recent
// one, so a stable name guarantees one check per commit whose status is
// always the latest run's outcome — state lives in title/summary instead.
export const KODY_CHECK_RUN_NAME = 'Kody Code Review';

/**
 * One annotation on a line of a file in the check run (GitHub's check run annotations). A request takes at most 50; the
 * caller sends more in follow-up updates of the same check run. Platforms without annotations ignore them.
 */
export interface CheckRunAnnotation {
    path: string;
    startLine: number;
    endLine: number;
    level: 'notice' | 'warning' | 'failure';
    title?: string;
    message: string;
}

export interface CreateCheckRunParams {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: {
        owner: string;
        name: string;
    };
    headSha: string;
    status: CheckStatus;
    name: string;
    output: {
        title: string;
        summary: string;
        text?: string;
        annotations?: CheckRunAnnotation[];
    };
}

export interface FindCheckRunParams {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: {
        owner: string;
        name: string;
    };
    headSha: string;
    name: string;
}

export interface UpdateCheckRunParams {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: {
        owner: string;
        name: string;
    };
    checkRunId: string | number;
    status?: CheckStatus;
    name?: string;
    conclusion?: CheckConclusion;
    output?: {
        title: string;
        summary: string;
        text?: string;
        annotations?: CheckRunAnnotation[];
    };
}

/**
 * A commit status on `sha`: the check's lifecycle and conclusion, posted
 * under `context`. Each post replaces the previous state of that context.
 */
export interface CreateCommitStatusParams {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: {
        owner: string;
        name: string;
    };
    sha: string;
    context: string;
    status: CheckStatus;
    /** Required when `status` is COMPLETED. */
    conclusion?: CheckConclusion;
    description: string;
    targetUrl?: string;
}

/**
 * What came of a commit status:
 * - posted: on the commit;
 * - permission_missing: the token may not write commit statuses (a 403 that
 *   is no rate limit), which only the customer can fix;
 * - failed: anything that can pass (5xx, network, rate limit); worth a retry.
 */
export type CommitStatusOutcome = 'posted' | 'permission_missing' | 'failed';

export interface IChecksAdapter {
    createCheckRun(
        params: CreateCheckRunParams,
    ): Promise<string | number | null>;
    updateCheckRun(params: UpdateCheckRunParams): Promise<boolean>;
    findCheckRun(params: FindCheckRunParams): Promise<string | number | null>;
    /**
     * Whether this org's connection can create check runs. False for a
     * GitHub personal access token: GitHub's Checks API takes writes from
     * GitHub Apps only. An adapter without it creates check runs whenever
     * the platform lets it.
     */
    isChecksApiAvailable?(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<boolean>;
    /**
     * The check as a commit status, for a connection that cannot create
     * check runs. Never throws for a platform refusal (see
     * CommitStatusOutcome); throws UnknownCheckConclusionError for a
     * completed status without a known conclusion.
     */
    createCommitStatus?(
        params: CreateCommitStatusParams,
    ): Promise<CommitStatusOutcome>;
}
