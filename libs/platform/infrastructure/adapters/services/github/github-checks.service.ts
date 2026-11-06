import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    CheckConclusion,
    CheckStatus,
    CreateCheckRunParams,
    FindCheckRunParams,
    IChecksAdapter,
    UpdateCheckRunParams,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { RateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { Injectable } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { GithubService } from './github.service';

enum GithubCheckStatus {
    QUEUED = 'queued',
    IN_PROGRESS = 'in_progress',
    COMPLETED = 'completed',
}

enum GithubCheckConclusion {
    ACTION_REQUIRED = 'action_required',
    CANCELLED = 'cancelled',
    FAILURE = 'failure',
    NEUTRAL = 'neutral',
    SUCCESS = 'success',
    SKIPPED = 'skipped',
    STALE = 'stale',
    TIMED_OUT = 'timed_out',
}

const checkStatusMap = {
    [CheckStatus.IN_PROGRESS]: GithubCheckStatus.IN_PROGRESS,
    [CheckStatus.COMPLETED]: GithubCheckStatus.COMPLETED,
} as const;

const checkConclusionMap = {
    [CheckConclusion.FAILURE]: GithubCheckConclusion.FAILURE,
    [CheckConclusion.SUCCESS]: GithubCheckConclusion.SUCCESS,
    [CheckConclusion.NEUTRAL]: GithubCheckConclusion.NEUTRAL,
    [CheckConclusion.SKIPPED]: GithubCheckConclusion.SKIPPED,
} as const;
export interface CompletedGithubCheckRun {
    id: number;
    conclusion: string;
    title?: string;
    htmlUrl?: string;
}

export interface MergeQueueEntry {
    /** The commit the merge queue built and tests for the PR. */
    queueSha: string;
    /** The PR head at the time of the lookup. */
    headSha: string;
}

@Injectable()
export class GithubChecksService implements IChecksAdapter {
    private readonly logger = createLogger(GithubChecksService.name);

    constructor(private readonly gitHubService: GithubService) {}

    /**
     * Newest completed run with this name posted by this deployment's App on
     * the commit. Returns null under PAT auth (no Checks API), when the App
     * id is unknown, or when none has completed; throws on GitHub errors so
     * callers can tell "no run" from "could not read". Runs from another App
     * using the same name are ignored, and so are `stale` ones, which only
     * GitHub can set.
     */
    async findLatestCompletedCheckRun(
        params: FindCheckRunParams,
    ): Promise<CompletedGithubCheckRun | null> {
        const { organizationAndTeamData, repository, headSha, name } = params;

        const authDetails = await this.gitHubService.getGithubAuthDetails(
            organizationAndTeamData,
        );
        if (authDetails.authMode === AuthMode.TOKEN) {
            return null;
        }

        const appId = this.gitHubService.getGithubAppId();
        if (!appId) {
            return null;
        }

        const octokit = await this.gitHubService.getAuthenticatedOctokit(
            organizationAndTeamData,
        );

        const response = await octokit.checks.listForRef({
            owner: repository.owner,
            repo: repository.name,
            ref: headSha,
            check_name: name,
            status: GithubCheckStatus.COMPLETED,
            filter: 'all',
            app_id: appId,
            per_page: 100,
        });

        const latest = (response.data.check_runs ?? [])
            .filter(
                (run) =>
                    run.status === GithubCheckStatus.COMPLETED &&
                    run.conclusion &&
                    // Octokit's types omit `stale`, but GitHub returns it.
                    (run.conclusion as string) !==
                        GithubCheckConclusion.STALE &&
                    run.completed_at,
            )
            .sort(
                (a, b) =>
                    Date.parse(b.completed_at) - Date.parse(a.completed_at),
            )[0];

        if (!latest) {
            return null;
        }

        return {
            id: latest.id,
            conclusion: latest.conclusion,
            title: latest.output?.title ?? undefined,
            htmlUrl: latest.html_url ?? undefined,
        };
    }

    /**
     * The commit GitHub's merge queue built for this PR and the PR head, in
     * one query, or null when the PR has no queue entry. Anyone with push
     * access can create a branch named like a queue branch, so only the queue
     * itself is trusted. Reading the queue needs no extra App permission.
     * A GraphQL rate limit is thrown as a RateLimitError; other GitHub errors
     * are thrown as is.
     */
    async findMergeQueueEntry(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { owner: string; name: string };
        prNumber: number;
    }): Promise<MergeQueueEntry | null> {
        const { organizationAndTeamData, repository, prNumber } = params;

        const octokit = await this.gitHubService.getAuthenticatedOctokit(
            organizationAndTeamData,
        );

        // The PR's own entry, so the lookup does not depend on queue depth.
        let response: {
            repository?: {
                pullRequest?: {
                    headRefOid?: string;
                    mergeQueueEntry?: {
                        headCommit?: { oid?: string } | null;
                    } | null;
                } | null;
            };
        };
        try {
            response = await octokit.graphql(
                `query ($owner: String!, $name: String!, $number: Int!) {
                    repository(owner: $owner, name: $name) {
                        pullRequest(number: $number) {
                            headRefOid
                            mergeQueueEntry {
                                headCommit { oid }
                            }
                        }
                    }
                }`,
                {
                    owner: repository.owner,
                    name: repository.name,
                    number: prNumber,
                },
            );
        } catch (error) {
            throw toGraphqlRateLimitError(error) ?? error;
        }

        const pullRequest = response?.repository?.pullRequest;
        const queueSha = pullRequest?.mergeQueueEntry?.headCommit?.oid;
        const headSha = pullRequest?.headRefOid;

        return queueSha && headSha ? { queueSha, headSha } : null;
    }

    async createCompletedCheckRun(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { owner: string; name: string };
        headSha: string;
        name: string;
        conclusion: string;
        detailsUrl?: string;
        output: { title: string; summary: string };
    }): Promise<number> {
        const {
            organizationAndTeamData,
            repository,
            headSha,
            name,
            conclusion,
            detailsUrl,
            output,
        } = params;

        const octokit = await this.gitHubService.getAuthenticatedOctokit(
            organizationAndTeamData,
        );

        const now = new Date().toISOString();
        const response = await octokit.checks.create({
            owner: repository.owner,
            repo: repository.name,
            name,
            head_sha: headSha,
            status: GithubCheckStatus.COMPLETED,
            conclusion: conclusion as GithubCheckConclusion,
            started_at: now,
            completed_at: now,
            ...(detailsUrl ? { details_url: detailsUrl } : {}),
            output,
        });

        return response.data.id;
    }

    async findCheckRun(params: FindCheckRunParams): Promise<number | null> {
        const { organizationAndTeamData, repository, headSha, name } = params;

        try {
            const authDetails = await this.gitHubService.getGithubAuthDetails(
                organizationAndTeamData,
            );

            if (authDetails.authMode === AuthMode.TOKEN) {
                return null;
            }

            const octokit = await this.gitHubService.getAuthenticatedOctokit(
                organizationAndTeamData,
            );

            const response = await octokit.checks.listForRef({
                owner: repository.owner,
                repo: repository.name,
                ref: headSha,
                check_name: name,
                filter: 'latest',
                per_page: 1,
            });

            const checkRun = response.data.check_runs?.[0];

            if (!checkRun) {
                return null;
            }

            // A completed check run cannot be reopened: PATCHing status back
            // to in_progress returns 200 but GitHub silently keeps
            // status=completed/conclusion. Only queued/in_progress runs are
            // reusable — for completed ones the caller creates a fresh run
            // with the same name, which the PR UI surfaces as the latest.
            if (checkRun.status === GithubCheckStatus.COMPLETED) {
                return null;
            }

            return checkRun.id;
        } catch (error) {
            this.logger.warn({
                message: `Failed to look up existing GitHub Check Run`,
                context: GithubChecksService.name,
                error,
                metadata: {
                    repository: repository.name,
                    headSha,
                    name,
                },
            });
            return null;
        }
    }

    async createCheckRun(params: CreateCheckRunParams): Promise<number | null> {
        const {
            organizationAndTeamData,
            repository,
            headSha,
            name,
            output,
            status,
        } = params;

        try {
            const authDetails = await this.gitHubService.getGithubAuthDetails(
                organizationAndTeamData,
            );

            if (authDetails.authMode === AuthMode.TOKEN) {
                this.logger.log({
                    message: `Skipping GitHub Check Run creation - not supported with PAT authentication`,
                    context: GithubChecksService.name,
                    metadata: {
                        repository: repository.name,
                        headSha,
                        authMode: authDetails.authMode,
                    },
                });
                return null;
            }

            const octokit = await this.gitHubService.getAuthenticatedOctokit(
                organizationAndTeamData,
            );

            const response = await octokit.checks.create({
                owner: repository.owner,
                repo: repository.name,
                name,
                head_sha: headSha,
                status: checkStatusMap[status] || GithubCheckStatus.IN_PROGRESS,
                started_at: new Date().toISOString(),
                output,
            });

            this.logger.log({
                message: `Created GitHub Check Run`,
                context: GithubChecksService.name,
                metadata: {
                    checkRunId: response.data.id,
                    repository: repository.name,
                    headSha,
                },
            });

            return response.data.id;
        } catch (error) {
            // 403 "Resource not accessible by integration": the installation
            // has not granted `checks:write` yet — customer-side, not ours.
            const missingPermission = error?.status === 403;
            this.logger[missingPermission ? 'warn' : 'error']({
                message: missingPermission
                    ? `Skipping GitHub Check Run - installation lacks checks permission`
                    : `Failed to create GitHub Check Run`,
                context: GithubChecksService.name,
                error,
                metadata: {
                    organizationId: organizationAndTeamData?.organizationId,
                    repository: repository.name,
                    headSha,
                },
            });
            return null;
        }
    }

    async updateCheckRun(params: UpdateCheckRunParams): Promise<boolean> {
        const {
            organizationAndTeamData,
            repository,
            checkRunId,
            status,
            name,
            output,
            conclusion,
        } = params;

        try {
            const authDetails = await this.gitHubService.getGithubAuthDetails(
                organizationAndTeamData,
            );

            if (authDetails.authMode === AuthMode.TOKEN) {
                this.logger.log({
                    message: `Skipping GitHub Check Run update - not supported with PAT authentication`,
                    context: GithubChecksService.name,
                    metadata: {
                        repository: repository.name,
                        checkRunId,
                        authMode: authDetails.authMode,
                    },
                });
                return false;
            }

            const octokit = await this.gitHubService.getAuthenticatedOctokit(
                organizationAndTeamData,
            );

            const updateData: Parameters<Octokit['checks']['update']>[0] = {
                owner: repository.owner,
                repo: repository.name,
                check_run_id:
                    typeof checkRunId === 'string'
                        ? parseInt(checkRunId, 10)
                        : checkRunId,
            };

            if (status) {
                updateData.status =
                    checkStatusMap[status] || GithubCheckStatus.IN_PROGRESS;
            }
            if (status === CheckStatus.COMPLETED || conclusion) {
                updateData.conclusion =
                    checkConclusionMap[conclusion] ||
                    GithubCheckConclusion.SUCCESS;
            }

            if (output) {
                updateData.output = output;
            }

            if (name) {
                updateData.name = name;
            }

            await octokit.checks.update(updateData);

            this.logger.log({
                message: `Updated GitHub Check Run`,
                context: GithubChecksService.name,
                metadata: {
                    checkRunId,
                    repository: repository.name,
                    status,
                    organizationAndTeamData,
                },
            });

            return true;
        } catch (error) {
            this.logger.error({
                message: `Failed to update GitHub Check Run`,
                context: GithubChecksService.name,
                error,
                metadata: {
                    checkRunId,
                    repository: repository.name,
                    organizationAndTeamData,
                },
            });
            return false;
        }
    }
}

/**
 * GitHub's GraphQL API reports an exhausted bucket in the response body
 * (`errors[].type: RATE_LIMITED`) with HTTP 200, so the header-based
 * classifier never sees it.
 */
function toGraphqlRateLimitError(error: unknown): RateLimitError | null {
    const graphqlErrors = (error as { errors?: Array<{ type?: string }> })
        ?.errors;
    if (
        !Array.isArray(graphqlErrors) ||
        !graphqlErrors.some((e) => e?.type === 'RATE_LIMITED')
    ) {
        return null;
    }

    const headers = (error as { headers?: Record<string, unknown> })?.headers;
    const reset = Number(headers?.['x-ratelimit-reset']);
    const resetAt =
        Number.isFinite(reset) && reset > 0
            ? new Date(reset * 1000)
            : new Date(Date.now() + 60_000);

    return new RateLimitError({
        resetAt,
        message: `GitHub GraphQL rate limit: reset at ${resetAt.toISOString()}`,
    });
}
