import { AutomationExecutionEntity } from '@libs/automation/domain/automationExecution/entities/automation-execution.entity';
import { CliReviewSummary } from '@libs/cli-review/dtos/cli-review-summary.dto';

interface CliDataExecution {
    correlationId?: string;
    userEmail?: string;
    cliVersion?: string;
    git?: {
        remote?: string;
        branch?: string;
        commitSha?: string;
        inferredPlatform?: string;
    };
    repositoryResolution?: {
        resolvedRepositoryId?: string;
        resolvedRepositoryName?: string | null;
    };
    cliAuth?: {
        mode?: 'team-key' | 'personal';
        teamKeyId?: string;
        teamKeyName?: string;
        userId?: string;
        userEmail?: string;
    };
    filesAnalyzed?: number;
    issuesFound?: number;
    duration?: number;
}

export function mapExecutionToSummary(
    execution: AutomationExecutionEntity,
): CliReviewSummary {
    const data = (execution.dataExecution || {}) as CliDataExecution;
    const finishedAt =
        execution.status === 'in_progress'
            ? null
            : execution.updatedAt ?? null;

    const durationMs =
        finishedAt && execution.createdAt
            ? new Date(finishedAt).getTime() -
              new Date(execution.createdAt).getTime()
            : data.duration ?? null;

    return {
        executionUuid: execution.uuid,
        correlationId: data.correlationId ?? null,
        status: execution.status,
        errorMessage: execution.errorMessage ?? null,
        createdAt: execution.createdAt,
        updatedAt: execution.updatedAt,
        finishedAt,
        durationMs,
        userEmail: data.userEmail ?? null,
        git: data.git
            ? {
                  remote: data.git.remote ?? null,
                  branch: data.git.branch ?? null,
                  commitSha: data.git.commitSha ?? null,
                  inferredPlatform: data.git.inferredPlatform ?? null,
              }
            : null,
        cliVersion: data.cliVersion ?? null,
        repositoryId:
            data.repositoryResolution?.resolvedRepositoryId ??
            (execution as any).repositoryId ??
            null,
        repositoryName:
            data.repositoryResolution?.resolvedRepositoryName ?? null,
        filesAnalyzed: data.filesAnalyzed ?? null,
        issuesFound: data.issuesFound ?? null,
        // Auth method that triggered the review. Only the identifier and
        // human label are exposed — the team key / JWT itself is never
        // persisted (and never reaches the dashboard).
        cliAuth: data.cliAuth?.mode
            ? {
                  mode: data.cliAuth.mode,
                  teamKeyName: data.cliAuth.teamKeyName ?? null,
                  loggedInUserEmail: data.cliAuth.userEmail ?? null,
              }
            : null,
    };
}
