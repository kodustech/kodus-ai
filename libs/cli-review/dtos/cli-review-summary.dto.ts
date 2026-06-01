import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';

export interface CliReviewTimelineItem {
    uuid: string;
    createdAt: Date;
    updatedAt: Date;
    status: AutomationStatus;
    message: string;
    stageName?: string | null;
    stageLabel?: string | null;
    metadata?: Record<string, unknown>;
    finishedAt?: Date | null;
}

export interface CliReviewSummary {
    executionUuid: string;
    correlationId?: string | null;
    status: AutomationStatus;
    errorMessage?: string | null;
    createdAt: Date;
    updatedAt: Date;
    finishedAt?: Date | null;
    durationMs?: number | null;
    userEmail?: string | null;
    git?: {
        remote?: string | null;
        branch?: string | null;
        commitSha?: string | null;
        inferredPlatform?: string | null;
    } | null;
    cliVersion?: string | null;
    repositoryId?: string | null;
    repositoryName?: string | null;
    filesAnalyzed?: number | null;
    issuesFound?: number | null;
    cliAuth?: {
        mode: 'team-key' | 'personal';
        teamKeyName?: string | null;
        loggedInUserEmail?: string | null;
    } | null;
}

export interface CliReviewDetail extends CliReviewSummary {
    timeline: CliReviewTimelineItem[];
    result?: unknown;
}

export interface PaginatedCliReviews {
    data: CliReviewSummary[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
}
