import { createLogger } from '@kodus/flow';
import { getMappedPlatform } from '@libs/common/utils/webhooks';
import { IntegrationConfigKey, PlatformType } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { with429Retry } from '@libs/core/infrastructure/http/rate-limit-retry';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { stripCurlyBracesFromUUIDs } from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-bitbucket.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import {
    IPullRequestsRepository,
    PULL_REQUESTS_REPOSITORY_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.repository';
import { IPullRequests } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class SavePullRequestUseCase {
    private readonly logger = createLogger(SavePullRequestUseCase.name);

    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,

        @Inject(PULL_REQUESTS_REPOSITORY_TOKEN)
        private readonly pullRequestsRepository: IPullRequestsRepository,

        private readonly codeManagement: CodeManagementService,
    ) {}

    public async execute(params: {
        payload: any;
        platformType: PlatformType;
        event: string;
    }): Promise<IPullRequests | null> {
        const { payload, platformType, event } = params;

        if (this.isValidPullRequestAction({ payload, platformType })) {
            const sanitizedPayload =
                platformType === PlatformType.BITBUCKET
                    ? stripCurlyBracesFromUUIDs(payload)
                    : payload;

            const mappedPlatform = getMappedPlatform(platformType);
            if (!mappedPlatform) {
                return;
            }

            const pullRequest = mappedPlatform.mapPullRequest({
                payload: sanitizedPayload,
            });
            if (
                !pullRequest &&
                !pullRequest?.number &&
                !pullRequest?.repository &&
                !pullRequest?.user
            ) {
                return;
            }

            const repository = mappedPlatform.mapRepository({
                payload: sanitizedPayload,
            });
            if (!repository && !repository?.id && !repository?.name) {
                return;
            }

            let organizationAndTeamData: OrganizationAndTeamData | null = null;

            try {
                const configs =
                    await this.integrationConfigService.findIntegrationConfigWithTeams(
                        IntegrationConfigKey.REPOSITORIES,
                        repository.id,
                        platformType,
                    );

                if (!configs || !configs.length) {
                    this.logger.warn({
                        message: `No repository configuration found for repository ${repository?.name}`,
                        context: SavePullRequestUseCase.name,
                        metadata: {
                            repositoryName: repository?.name,
                            pullRequestNumber: pullRequest?.number,
                        },
                    });

                    return null;
                }

                const organizationAndTeamDataList: OrganizationAndTeamData[] =
                    configs.map((config) => ({
                        organizationId: config.team.organization.uuid,
                        teamId: config.team.uuid,
                    }));

                organizationAndTeamData =
                    organizationAndTeamDataList[0] ?? null;

                const relevantUsers = mappedPlatform.mapUsers({
                    payload: sanitizedPayload,
                });

                let resolvedUsers = relevantUsers;

                // GitLab webhook's top-level `user` is the actor (pusher /
                // commenter), not the MR author. Replace it with the real
                // author so the persisted PR record reflects who opened it.
                if (platformType === PlatformType.GITLAB) {
                    const author =
                        await this.codeManagement.resolveMrAuthorFromWebhookPayload(
                            {
                                payload: sanitizedPayload,
                                organizationAndTeamData,
                            },
                            PlatformType.GITLAB,
                        );
                    if (author) {
                        this.logger.log({
                            message:
                                'GitLab webhook actor replaced by resolved MR author',
                            context: SavePullRequestUseCase.name,
                            metadata: {
                                organizationAndTeamData,
                                mrIid: pullRequest?.number,
                                webhookActorId: sanitizedPayload?.user?.id,
                                resolvedAuthorId: author?.id,
                            },
                        });
                        resolvedUsers = {
                            ...(relevantUsers ?? {}),
                            user: author,
                        } as any;
                    }
                }

                const pullRequestWithUserData: any = {
                    ...pullRequest,
                    ...resolvedUsers,
                };

                // Optimization: Only fetch files/commits from Git API when needed
                // - For new PRs (opened) or new commits (synchronize): fetch from API
                // - For other events (closed, reopened, etc.): use existing data from DB
                const shouldFetchFromApi = this.shouldFetchFilesAndCommits(
                    payload,
                    platformType,
                );

                let changedFiles: any[] = [];
                let pullRequestCommits: any[] = [];

                if (shouldFetchFromApi) {
                    // Sequential + per-call 429 retry. Previously this was a
                    // Promise.all of two parallel provider calls, which on
                    // gitlab webhook bursts (post-2026-04-29 d51ece1a2) was
                    // pinning the @gitbeaker retry budget — both calls would
                    // race the same per-endpoint rate limit and 429 in
                    // lockstep, causing webhook handler 500s and the review
                    // pipeline never starting. Sequential cuts in-flight
                    // calls from 2→1; with429Retry honours Retry-After and
                    // recovers from transient bursts. The extra ~300ms of
                    // wall time per webhook is below the human noise floor.
                    changedFiles = await with429Retry(
                        () =>
                            this.codeManagement.getFilesByPullRequestId(
                                {
                                    organizationAndTeamData,
                                    prNumber: pullRequest?.number,
                                    repository,
                                },
                                platformType,
                            ),
                        { label: `saveSync:getFiles PR#${pullRequest?.number}` },
                    );
                    pullRequestCommits = await with429Retry(
                        () =>
                            this.codeManagement.getCommitsForPullRequestForCodeReview(
                                {
                                    organizationAndTeamData,
                                    repository: {
                                        id: repository.id,
                                        name: repository.name,
                                    },
                                    prNumber: pullRequestWithUserData.number,
                                },
                            ),
                        {
                            label: `saveSync:getCommits PR#${pullRequestWithUserData.number}`,
                        },
                    );
                } else {
                    // For non-critical events, try to get existing data from DB
                    const existingPR =
                        await this.pullRequestsRepository.findByNumberAndRepositoryId(
                            pullRequest?.number,
                            repository.id,
                            organizationAndTeamData,
                        );

                    if (existingPR) {
                        // Map DB file format back to API format for compatibility
                        // DB stores: { path, filename (short), added, deleted, previousName }
                        // API returns: { filename (full path), additions, deletions, previous_filename }
                        changedFiles = (existingPR.files || []).map(
                            (f: any) => ({
                                filename: f.path || f.filename,
                                additions: f.added ?? 0,
                                deletions: f.deleted ?? 0,
                                changes: f.changes ?? 0,
                                patch: f.patch ?? '',
                                sha: f.sha ?? '',
                                status: f.status ?? '',
                                previous_filename: f.previousName ?? '',
                            }),
                        );
                        pullRequestCommits = existingPR.commits || [];

                        this.logger.debug({
                            message: `Using cached files/commits for PR#${pullRequest?.number} (action: ${payload?.action || payload?.object_attributes?.action})`,
                            context: SavePullRequestUseCase.name,
                            metadata: {
                                prNumber: pullRequest?.number,
                                filesCount: changedFiles.length,
                                commitsCount: pullRequestCommits.length,
                                organizationAndTeamData,
                            },
                        });
                    }
                }

                try {
                    const result =
                        await this.pullRequestsService.aggregateAndSaveDataStructure(
                            pullRequestWithUserData,
                            repository,
                            changedFiles,
                            [],
                            [],
                            platformType,
                            organizationAndTeamData,
                            pullRequestCommits,
                        );

                    return result;
                } catch (error) {
                    this.logger.error({
                        message: `Failed to aggregate and save pull request data for PR#${pullRequestWithUserData?.number}`,
                        context: SavePullRequestUseCase.name,
                        error,
                        metadata: {
                            repository: repository?.name,
                            pullRequest: pullRequestWithUserData?.number,
                            organizationAndTeamData,
                            platformType,
                            event,
                        },
                    });
                    return null;
                }
            } catch (error) {
                this.logger.error({
                    message: `Failed to save pull request data for PR#${pullRequest?.number}`,
                    context: SavePullRequestUseCase.name,
                    error,
                    metadata: {
                        repository: repository?.name,
                        pullRequest: pullRequest?.number,
                        organizationAndTeamData,
                        platformType,
                        event,
                    },
                });
            }
        }
    }

    private isValidPullRequestAction(params: {
        payload: any;
        platformType: PlatformType;
    }): boolean {
        const { payload, platformType } = params;

        const validActions = [
            'opened',
            'closed',
            'synchronize',
            'synchronized',
            'review_requested',
            'review_request_removed',
            'assigned',
            'unassigned',
            'active',
            'completed',
            'ready_for_review',
        ] as const;
        const validObjectActions = [
            'open',
            'close',
            'merge',
            'update',
        ] as const;

        // bitbucket was already validated by the webhook type
        return (
            validActions.includes(payload?.action) ||
            validObjectActions.includes(payload?.object_attributes?.action) ||
            validActions.includes(payload?.resource?.status) ||
            validActions.includes(payload?.resource?.pullRequest?.status) ||
            platformType === PlatformType.BITBUCKET
        );
    }

    /**
     * Determines if we need to fetch files and commits from the Git API.
     * Only fetch for events that actually change the PR content:
     * - opened: new PR, need all data
     * - synchronize: new commits pushed, need updated data
     * - ready_for_review: draft converted to ready, may need fresh data
     * - open (GitLab): new MR
     * - update with new commits (GitLab): new commits pushed
     *
     * For other events (closed, reopened, assigned, etc.), we can use cached data
     * from the database since the files/commits haven't changed.
     */
    private shouldFetchFilesAndCommits(
        payload: any,
        platformType: PlatformType,
    ): boolean {
        // GitHub actions that require fresh data
        const githubFetchActions = [
            'opened',
            'synchronize',
            'synchronized',
            'ready_for_review',
        ];
        if (githubFetchActions.includes(payload?.action)) {
            return true;
        }

        // GitLab: open or update with new commits
        const gitlabAction = payload?.object_attributes?.action;
        if (gitlabAction === 'open') {
            return true;
        }
        if (gitlabAction === 'update') {
            // Check if it's a commit update (oldrev differs from last_commit)
            const lastCommitId = payload?.object_attributes?.last_commit?.id;
            const oldRev = payload?.object_attributes?.oldrev;
            if (lastCommitId && oldRev && lastCommitId !== oldRev) {
                return true;
            }
        }

        // Azure DevOps: active status means new/updated PR
        if (
            payload?.resource?.status === 'active' ||
            payload?.resource?.pullRequest?.status === 'active'
        ) {
            return true;
        }

        // Bitbucket: check for push events or new PRs
        if (platformType === PlatformType.BITBUCKET) {
            // For Bitbucket, we need to be more conservative
            // Fetch if it looks like a new PR or has new commits
            const isPullRequestCreated =
                payload?.pullrequest?.state === 'OPEN' &&
                !payload?.previous?.state;
            const hasNewCommits = payload?.push?.changes?.length > 0;
            if (isPullRequestCreated || hasNewCommits) {
                return true;
            }
            // For other Bitbucket events, still fetch to be safe
            // (Bitbucket webhook structure varies)
            return true;
        }

        // For all other events (closed, merged, reopened, assigned, etc.)
        // we don't need to fetch files/commits - they haven't changed
        return false;
    }
}
