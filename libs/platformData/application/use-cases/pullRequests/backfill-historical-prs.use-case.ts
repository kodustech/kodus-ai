import { Injectable, Inject } from '@nestjs/common';
import { createLogger } from '@kodus/flow';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { with429Retry } from '@libs/core/infrastructure/http/rate-limit-retry';
import { IPullRequests } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

// Sleep between historical-PR fetches. With sequential per-PR calls +
// per-call 429 retry, a tight loop over 30+ PRs on a fresh onboarding
// still trips bitbucket's per-endpoint burst limit (16-60 req/min on
// /pullrequests/N/diffstat + /pullrequests/N/commits). 2000ms keeps
// the pair of calls per PR at ~0.5 req/sec on each endpoint, well
// inside even bitbucket's most aggressive burst windows. Total
// backfill of MAX_BACKFILL_PRS_PER_REPO at this rate stays under
// ~40s — acceptable for a detached setImmediate background job that
// nobody is waiting on.
const PER_PR_DELAY_MS = 2000;

// Cap the per-repository historical backfill. The dashboard view we
// hydrate from these saved PRs is meaningful with the last 10
// merges/closes; we don't need 2 months of history at onboarding. This
// cap is the difference between a backfill that fits inside any
// provider's burst budget and one that 429s halfway through and leaves
// the dashboard with a ragged tail. Operators can rerun a fuller
// backfill later via the explicit API once the burst window has
// refilled.
const MAX_BACKFILL_PRS_PER_REPO = 10;
import {
    IPullRequestsRepository,
    PULL_REQUESTS_REPOSITORY_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.repository';
import { PullRequest } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

interface BackfillParams {
    organizationAndTeamData: OrganizationAndTeamData;
    repositories: Array<{
        id: string;
        name: string;
        fullName?: string;
        url?: string;
    }>;
    startDate?: string;
    endDate?: string;
}

@Injectable()
export class BackfillHistoricalPRsUseCase {
    private readonly logger = createLogger(BackfillHistoricalPRsUseCase.name);

    constructor(
        private readonly codeManagementService: CodeManagementService,
        @Inject(PULL_REQUESTS_REPOSITORY_TOKEN)
        private readonly pullRequestsRepository: IPullRequestsRepository,
    ) {}

    public async execute(params: BackfillParams): Promise<void> {
        const { organizationAndTeamData, repositories, startDate, endDate } =
            params;

        const defaultStartDate =
            startDate ||
            new Date(
                new Date().setMonth(new Date().getMonth() - 2),
            ).toISOString();
        const defaultEndDate = endDate || new Date().toISOString();

        this.logger.log({
            message: 'Starting PR historical backfill',
            context: BackfillHistoricalPRsUseCase.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                repositoriesCount: repositories.length,
                startDate: defaultStartDate,
                endDate: defaultEndDate,
            },
        });

        await Promise.all(
            repositories.map(async (repository) => {
                try {
                    await this.backfillRepositoryPRs(
                        organizationAndTeamData,
                        repository,
                        defaultStartDate,
                        defaultEndDate,
                    );
                } catch (error) {
                    this.logger.error({
                        message: `Error during backfill for repository ${repository.name}`,
                        context: BackfillHistoricalPRsUseCase.name,
                        error: error.message,
                        metadata: {
                            organizationId:
                                organizationAndTeamData.organizationId,
                            teamId: organizationAndTeamData.teamId,
                            repositoryId: repository.id,
                            repositoryName: repository.name,
                        },
                    });
                }
            }),
        );

        this.logger.log({
            message: 'Completed PR historical backfill',
            context: BackfillHistoricalPRsUseCase.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                repositoriesCount: repositories.length,
            },
        });
    }

    private async backfillRepositoryPRs(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: {
            id: string;
            name: string;
            fullName?: string;
            url?: string;
        },
        startDate: string,
        endDate: string,
    ): Promise<void> {
        this.logger.log({
            message: `Fetching PRs for repository ${repository.name}`,
            context: BackfillHistoricalPRsUseCase.name,
            metadata: {
                repositoryId: repository.id,
                repositoryName: repository.name,
                startDate,
                endDate,
            },
        });

        const allPullRequests =
            await this.codeManagementService.getPullRequestsByRepository({
                organizationAndTeamData,
                repository: {
                    id: repository.id,
                    name: repository.name,
                },
                filters: {
                    startDate,
                    endDate,
                },
            });

        if (!allPullRequests || allPullRequests.length === 0) {
            this.logger.log({
                message: `No PRs found for repository ${repository.name}`,
                context: BackfillHistoricalPRsUseCase.name,
                metadata: {
                    repositoryId: repository.id,
                    repositoryName: repository.name,
                },
            });
            return;
        }

        // Cap historical backfill so we don't burn the entire bb/github
        // burst budget on a single onboarding. The dashboard view we
        // hydrate from these saved PRs is useful with the most recent
        // N, not every PR from the last 2 months. Operators can run a
        // fuller backfill later from the dedicated endpoint.
        const pullRequests = allPullRequests.slice(
            0,
            MAX_BACKFILL_PRS_PER_REPO,
        );

        this.logger.log({
            message: `Found ${allPullRequests.length} PRs for repository ${repository.name}; backfilling first ${pullRequests.length}`,
            context: BackfillHistoricalPRsUseCase.name,
            metadata: {
                repositoryId: repository.id,
                repositoryName: repository.name,
                pullRequestsCount: pullRequests.length,
            },
        });

        let savedCount = 0;
        let skippedCount = 0;

        for (const pr of pullRequests) {
            try {
                const existingPR =
                    await this.pullRequestsRepository.findByNumberAndRepositoryId(
                        pr.number,
                        repository.id,
                        organizationAndTeamData,
                    );

                if (existingPR) {
                    skippedCount++;
                    continue;
                }

                let fileStats = {
                    totalAdded: 0,
                    totalDeleted: 0,
                    totalChanges: 0,
                };
                let commits = [];

                try {
                    // Sequential + per-call 429 retry. The old Promise.all
                    // of two parallel calls per PR is what tipped bitbucket
                    // Atlassian Edge into x-envoy-ratelimited=true during
                    // the 2026-05-23 matrix run on kodustech/tiny-url
                    // (38+ historical PRs) — finishOnboarding 500'd before
                    // the user-visible response could land. Going serial
                    // halves the peak in-flight count; with429Retry on
                    // each call honours Retry-After so a transient burst
                    // doesn't doom the whole backfill.
                    // Backfill runs detached — there's no human waiting
                    // on a tight latency budget — so be generous on
                    // patience. 6 attempts × max 60s delay = up to ~2min
                    // of waiting on a single call, which lets us ride
                    // out even bitbucket's longest observed burst-window
                    // cooldown (the Atlassian Edge x-envoy-ratelimited
                    // window we saw on 2026-05-23 cleared in ~14min on
                    // some endpoints, but per-endpoint short windows
                    // typically refill in 30-90s).
                    const retryOpts = {
                        maxAttempts: 6,
                        baseDelayMs: 2_000,
                        maxDelayMs: 60_000,
                    };
                    const files = await with429Retry(
                        () =>
                            this.codeManagementService.getFilesByPullRequestId(
                                {
                                    organizationAndTeamData,
                                    repository: {
                                        id: repository.id,
                                        name: repository.name,
                                    },
                                    prNumber: pr.number,
                                },
                            ),
                        { ...retryOpts, label: `backfill:getFiles PR#${pr.number}` },
                    );
                    const prCommits = await with429Retry(
                        () =>
                            this.codeManagementService.getCommitsForPullRequestForCodeReview(
                                {
                                    organizationAndTeamData,
                                    repository: {
                                        id: repository.id,
                                        name: repository.name,
                                    },
                                    prNumber: pr.number,
                                },
                            ),
                        {
                            ...retryOpts,
                            label: `backfill:getCommits PR#${pr.number}`,
                        },
                    );

                    if (files && files.length > 0) {
                        fileStats = {
                            totalAdded: files.reduce(
                                (sum, file) => sum + (file.additions || 0),
                                0,
                            ),
                            totalDeleted: files.reduce(
                                (sum, file) => sum + (file.deletions || 0),
                                0,
                            ),
                            totalChanges: files.reduce(
                                (sum, file) => sum + (file.changes || 0),
                                0,
                            ),
                        };
                    }

                    if (prCommits && prCommits.length > 0) {
                        commits = prCommits.map((commit) => ({
                            sha: commit.sha || '',
                            message: commit.message || '',
                            author: {
                                id: commit.author?.id || '',
                                username:
                                    commit.author?.username ||
                                    commit.author?.name ||
                                    '',
                                name: commit.author?.name || '',
                                email: commit.author?.email || '',
                                date:
                                    commit.created_at ||
                                    commit.author?.date ||
                                    new Date().toISOString(),
                            },
                            createdAt:
                                commit.created_at ||
                                commit.author?.date ||
                                new Date().toISOString(),
                        }));
                    }
                } catch (dataError) {
                    this.logger.warn({
                        message: `Could not fetch files/commits for PR #${pr.number}, using default values`,
                        context: BackfillHistoricalPRsUseCase.name,
                        metadata: {
                            repositoryName: repository.name,
                            prNumber: pr.number,
                            error: dataError.message,
                        },
                    });
                }

                const prDocument = this.transformPullRequestToDocument(
                    pr,
                    organizationAndTeamData.organizationId,
                    fileStats,
                    commits,
                    repository,
                );

                await this.pullRequestsRepository.create(prDocument);
                savedCount++;
            } catch (error) {
                this.logger.error({
                    message: `Error saving PR #${pr.number}`,
                    context: BackfillHistoricalPRsUseCase.name,
                    error: error.message,
                    metadata: {
                        repositoryName: repository.name,
                        prNumber: pr.number,
                    },
                });
            }

            // Pace the loop so we don't pin the provider's per-endpoint
            // burst budget. See PER_PR_DELAY_MS comment at the top of
            // the file for the rationale.
            if (PER_PR_DELAY_MS > 0) {
                await new Promise((resolve) =>
                    setTimeout(resolve, PER_PR_DELAY_MS),
                );
            }
        }

        this.logger.log({
            message: `Completed backfill for repository ${repository.name}`,
            context: BackfillHistoricalPRsUseCase.name,
            metadata: {
                repositoryId: repository.id,
                repositoryName: repository.name,
                savedCount,
                skippedCount,
                totalProcessed: pullRequests.length,
            },
        });
    }

    private transformPullRequestToDocument(
        pr: PullRequest,
        organizationId: string,
        fileStats: {
            totalAdded: number;
            totalDeleted: number;
            totalChanges: number;
        },
        commits: any[],
        repository: {
            id: string;
            name: string;
            fullName?: string;
            url?: string;
        },
    ): Omit<IPullRequests, 'uuid'> {
        const isMerged = !!pr.merged_at;
        const repoData = pr.head?.repo || pr.base?.repo;

        return {
            title: pr.title || '',
            status: pr.state || 'unknown',
            merged: isMerged,
            number: pr.number,
            url: pr.prURL || '',
            baseBranchRef: pr.base?.ref || pr.targetRefName || '',
            headBranchRef: pr.head?.ref || pr.sourceRefName || '',
            repository: {
                id:
                    repoData?.id ||
                    pr.repositoryData?.id ||
                    pr.repositoryId ||
                    '',
                name: repoData?.name || pr.repositoryData?.name || '',
                fullName: repoData?.fullName || repository.fullName || '',
                language: '',
                url: repository.url || '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            openedAt: pr.created_at || new Date().toISOString(),
            closedAt: pr.closed_at || '',
            files: [],
            totalAdded: fileStats.totalAdded,
            totalDeleted: fileStats.totalDeleted,
            totalChanges: fileStats.totalChanges,
            createdAt: pr.created_at || new Date().toISOString(),
            updatedAt: pr.updated_at || new Date().toISOString(),
            provider: '',
            user: {
                id: pr.user?.id || '',
                username: pr.user?.login || pr.user?.name || '',
            },
            reviewers:
                pr.reviewers?.map((reviewer) => ({
                    id: String(reviewer.id) || '',
                    username: '',
                })) || [],
            assignees:
                pr.participants?.map((participant) => ({
                    id: String(participant.id) || '',
                    username: '',
                })) || [],
            organizationId,
            commits,
            syncedEmbeddedSuggestions: false,
            syncedWithIssues: false,
            isDraft: pr.isDraft || false,
        };
    }
}
