import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@libs/automation/domain/automation/contracts/automation.service';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { AutomationType } from '@libs/automation/domain/automation/enum/automation-type';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@libs/automation/domain/teamAutomation/contracts/team-automation.service';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import {
    IPullRequestMessagesService,
    PULL_REQUEST_MESSAGES_SERVICE_TOKEN,
} from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { CodeReviewConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { IntegrationStatusFilter } from '@libs/organization/domain/team/interfaces/team.interface';
import { AzureRepoCommentTypeString } from '@libs/platform/domain/azure/entities/azureRepoExtras.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { IPullRequestWithDeliveredSuggestions } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

const API_CRON_CHECK_IF_PR_SHOULD_BE_APPROVED =
    process.env.API_CRON_CHECK_IF_PR_SHOULD_BE_APPROVED;

@Injectable()
export class CheckIfPRCanBeApprovedCronProvider {
    private readonly logger = createLogger(
        CheckIfPRCanBeApprovedCronProvider.name,
    );
    private pullRequestMessagesCache = new Map<
        string,
        IPullRequestMessages | null
    >();

    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,
        private readonly codeManagementService: CodeManagementService,
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,
        @Inject(PULL_REQUEST_MESSAGES_SERVICE_TOKEN)
        private readonly pullRequestMessagesService: IPullRequestMessagesService,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    @Cron(API_CRON_CHECK_IF_PR_SHOULD_BE_APPROVED, {
        name: 'CHECK IF PR SHOULD BE APPROVED',
        timeZone: 'America/Sao_Paulo',
        waitForCompletion: true,
    })
    async handleCron() {
        const lockKey = 'CRON:CHECK_IF_PR_SHOULD_BE_APPROVED';

        let lock: DistributedLock;
        try {
            lock = await this.distributedLockService.acquire(lockKey, {
                ttl: 1000 * 60 * 5, // 5 minutes TTL to prevent stale locks
            });

            if (!lock) {
                this.logger.log({
                    message: 'Cron execution skipped - Lock already acquired',
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: { lockKey },
                });
                return;
            }
        } catch (error) {
            this.logger.error({
                message: 'Error acquiring distributed lock for cron execution',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                metadata: { lockKey },
                error,
            });
            return;
        }

        // Clear cache at start of each cron run
        this.pullRequestMessagesCache.clear();

        try {
            this.logger.log({
                message: 'Check if PR can be approved cron started',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                metadata: {
                    timestamp: new Date().toISOString(),
                },
            });

            const teams = await this.teamService.findTeamsWithIntegrations({
                integrationCategories: [IntegrationCategory.CODE_MANAGEMENT],
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                status: STATUS.ACTIVE,
            });

            if (!teams || teams.length === 0) {
                this.logger.log({
                    message: 'No teams found',
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: {
                        timestamp: new Date().toISOString(),
                    },
                });

                return;
            }

            // Fetch automation ONCE (same for all teams)
            const codeReviewAutomation = await this.automationService.find({
                automationType: AutomationType.AUTOMATION_CODE_REVIEW,
            });

            if (!codeReviewAutomation?.[0]) {
                this.logger.error({
                    message: 'Code review automation not found',
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                });
                return;
            }

            const automationUuid = codeReviewAutomation[0].uuid;

            // Calculate once outside loop
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            const now = new Date();

            // Fetch all parameters in parallel (non-blocking)
            const parametersPromises = teams.map((team) =>
                this.parametersService
                    .findOne({
                        configKey: ParametersKey.CODE_REVIEW_CONFIG,
                        team: { uuid: team.uuid },
                        active: true,
                    })
                    .catch((error) => {
                        this.logger.error({
                            message: 'Error fetching parameter for team',
                            context: CheckIfPRCanBeApprovedCronProvider.name,
                            metadata: { teamId: team.uuid },
                            error,
                        });
                        return null;
                    }),
            );

            const allParameters = await Promise.all(parametersPromises);

            // Create lookup map for O(1) access (guaranteed by the returned teamId)
            const parametersByTeam = new Map(
                allParameters
                    .filter((param) => param?.team?.uuid)
                    .map((param) => [param.team.uuid, param]),
            );

            // Fetch all teamAutomations in parallel
            const teamAutomationsPromises = teams.map((team) =>
                this.teamAutomationService
                    .find({
                        team: { uuid: team.uuid },
                        automation: { uuid: automationUuid },
                    })
                    .catch((error) => {
                        this.logger.error({
                            message: 'Error fetching team automation',
                            context: CheckIfPRCanBeApprovedCronProvider.name,
                            metadata: { teamId: team.uuid },
                            error,
                        });
                        return [];
                    }),
            );

            const allTeamAutomations = await Promise.all(
                teamAutomationsPromises,
            );

            // Create lookup map using teamId from first automation
            const teamAutomationsByTeam = new Map(
                allTeamAutomations
                    .filter((automations) => automations?.length > 0)
                    .map((automations) => [
                        automations[0].team?.uuid,
                        automations[0],
                    ]),
            );

            // Process teams in parallel
            await Promise.allSettled(
                teams.map(async (team) => {
                    const organizationId = team.organization?.uuid;
                    const teamId = team.uuid;

                    const organizationAndTeamData: OrganizationAndTeamData = {
                        organizationId,
                        teamId,
                    };

                    const codeReviewParameter = parametersByTeam.get(teamId);

                    if (!codeReviewParameter?.configValue) {
                        return;
                    }

                    const codeReviewConfig = codeReviewParameter?.configValue;

                    if (
                        !codeReviewParameter ||
                        !codeReviewConfig ||
                        !Array.isArray(codeReviewConfig.repositories) ||
                        codeReviewConfig.repositories?.length < 1
                    ) {
                        return;
                    }

                    const teamAutomation = teamAutomationsByTeam.get(teamId);

                    if (!teamAutomation) {
                        return;
                    }

                    const eligiblePullRequestRefs =
                        await this.automationExecutionService.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId(
                            sevenDaysAgo,
                            now,
                            teamAutomation.uuid,
                        );

                    const eligiblePullRequestKeys = new Set(
                        eligiblePullRequestRefs.map(
                            (ref) =>
                                `${ref.repositoryId}:${ref.pullRequestNumber}`,
                        ),
                    );

                    const automationExecutionsPRs = [
                        ...new Set(
                            eligiblePullRequestRefs
                                .map((ref) => ref.pullRequestNumber)
                                .filter((prNumber): prNumber is number =>
                                    Number.isInteger(prNumber),
                                ),
                        ),
                    ];

                    if (!automationExecutionsPRs?.length) {
                        return;
                    }

                    const openPullRequests =
                        await this.pullRequestService.findPullRequestsWithDeliveredSuggestions(
                            organizationId,
                            automationExecutionsPRs,
                            PullRequestState.OPENED,
                        );

                    this.logger.log({
                        message: 'Open pull requests found',
                        context: CheckIfPRCanBeApprovedCronProvider.name,
                        metadata: {
                            openPullRequests: openPullRequests?.length,
                            organizationAndTeamData: {
                                organizationId,
                                teamId,
                            },
                        },
                    });

                    if (!openPullRequests || openPullRequests?.length === 0) {
                        return;
                    }

                    const eligibleOpenPullRequests = openPullRequests.filter(
                        (pr) =>
                            eligiblePullRequestKeys.has(
                                `${pr?.repository?.id}:${pr?.number}`,
                            ),
                    );

                    if (!eligibleOpenPullRequests.length) {
                        return;
                    }

                    // Process PRs in parallel with proper error handling
                    await Promise.allSettled(
                        eligibleOpenPullRequests.map(async (pr) => {
                            const repository = pr?.repository;

                            const codeReviewConfigFromRepo =
                                codeReviewConfig?.repositories?.find(
                                    (codeReviewConfigRepo) =>
                                        codeReviewConfigRepo?.id ===
                                        repository?.id,
                                );

                            if (!codeReviewConfigFromRepo) {
                                return;
                            }

                            const resolvedConfig =
                                await this.codeBaseConfigService.getConfig(
                                    organizationAndTeamData,
                                    {
                                        id: codeReviewConfigFromRepo.id,
                                        name: codeReviewConfigFromRepo.name,
                                    },
                                    [],
                                );

                            if (
                                resolvedConfig?.pullRequestApprovalActive ===
                                false
                            ) {
                                return;
                            }

                            await this.shouldApprovePR({
                                organizationAndTeamData,
                                pr,
                                codeReviewConfig: resolvedConfig,
                                teamAutomationId: teamAutomation.uuid,
                            });
                        }),
                    );
                }),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error checking if PR can be approved generator cron',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                error,
                metadata: {
                    timestamp: new Date().toISOString(),
                },
            });
        } finally {
            try {
                await lock.release();
            } catch (error) {
                this.logger.error({
                    message:
                        'Error releasing distributed lock after cron execution',
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: { lockKey },
                    error,
                });
            }
        }
    }

    private async shouldApprovePR({
        organizationAndTeamData,
        pr,
        codeReviewConfig,
        teamAutomationId,
    }: {
        organizationAndTeamData: OrganizationAndTeamData;
        pr: IPullRequestWithDeliveredSuggestions;
        codeReviewConfig?: CodeReviewConfig;
        teamAutomationId: string;
    }): Promise<boolean> {
        const repository = pr?.repository;
        const prNumber = pr?.number;
        const platformType = pr?.provider as PlatformType;

        const codeManagementRequestData = {
            organizationAndTeamData,
            repository: {
                id: repository?.id,
                name: repository?.name,
            },
            prNumber: prNumber,
        };

        const lastExecution =
            await this.automationExecutionService.findLatestExecutionByFilters({
                status: AutomationStatus.SUCCESS,
                teamAutomation: { uuid: teamAutomationId },
                pullRequestNumber: prNumber,
                repositoryId: repository?.id,
            });

        const lastAnalyzedCommitSha = this.getLastAnalyzedCommitSha(
            lastExecution?.dataExecution?.lastAnalyzedCommit,
        );

        if (lastAnalyzedCommitSha) {
            const currentPullRequest =
                await this.codeManagementService.getPullRequest(
                    {
                        organizationAndTeamData,
                        repository: {
                            id: repository?.id,
                            name: repository?.name,
                        },
                        prNumber: prNumber,
                    },
                    platformType,
                );

            const currentHeadSha =
                currentPullRequest?.head?.sha ||
                (currentPullRequest as any)?.headSha ||
                (currentPullRequest as any)?.head?.commit?.sha;

            if (currentHeadSha && currentHeadSha !== lastAnalyzedCommitSha) {
                this.logger.log({
                    message: `Skipping approval for PR#${prNumber} due to new commit since last reviewed commit`,
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: {
                        organizationAndTeamData,
                        repository: {
                            id: repository?.id,
                            name: repository?.name,
                        },
                        prNumber,
                        lastAnalyzedCommitSha,
                        currentHeadSha,
                    },
                });

                return false;
            }
        }

        try {
            let reviewComments: any[];

            if (platformType === PlatformType.GITHUB) {
                reviewComments =
                    await this.codeManagementService.getPullRequestReviewThreads(
                        codeManagementRequestData,
                        PlatformType.GITHUB,
                    );
            } else {
                reviewComments =
                    await this.codeManagementService.getPullRequestReviewComments(
                        codeManagementRequestData,
                        platformType,
                    );
            }

            this.logger.log({
                message: `Review comments found for PR#${prNumber}`,
                context: CheckIfPRCanBeApprovedCronProvider.name,
                metadata: {
                    reviewComments: reviewComments?.length,
                    organizationAndTeamData,
                    prNumber,
                    repository: {
                        name: repository?.name,
                        id: repository?.id,
                    },
                },
            });

            if (platformType === PlatformType.AZURE_REPOS) {
                reviewComments = reviewComments?.filter(
                    (comment) =>
                        comment?.commentType ===
                        AzureRepoCommentTypeString.CODE,
                );
            }

            if (!reviewComments || reviewComments?.length < 1) {
                return false;
            }

            if (pr?.suggestions && pr?.suggestions?.length > 0) {
                const deliveredCommentIds = new Set(
                    pr.suggestions
                        .filter((s) => s?.comment?.id)
                        .map((s) => String(s.comment.id)),
                );

                reviewComments = reviewComments.filter((comment) => {
                    let commentId;

                    if (platformType === PlatformType.GITHUB) {
                        commentId = comment?.fullDatabaseId || comment?.id;
                    } else if (platformType === PlatformType.AZURE_REPOS) {
                        commentId = comment?.threadId;
                    } else {
                        commentId = comment?.id;
                    }

                    if (!commentId) {
                        return false;
                    }

                    return deliveredCommentIds.has(String(commentId));
                });

                this.logger.log({
                    message: `Filtered review comments by delivered suggestions for PR#${prNumber}`,
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: {
                        totalDeliveredSuggestions: pr?.suggestions?.length,
                        filteredReviewComments: reviewComments.length,
                        organizationAndTeamData,
                        prNumber,
                        repository: {
                            name: repository?.name,
                            id: repository?.id,
                        },
                    },
                });

                if (!reviewComments || reviewComments?.length < 1) {
                    return false;
                }
            }

            const pullRequestMessagesConfig =
                await this.setPullRequestMessagesConfig(
                    repository,
                    organizationAndTeamData,
                    codeReviewConfig,
                );

            if (pullRequestMessagesConfig) {
                const startMessageContent =
                    pullRequestMessagesConfig?.startReviewMessage?.content;
                const endMessageContent =
                    pullRequestMessagesConfig?.endReviewMessage?.content;

                if (startMessageContent || endMessageContent) {
                    reviewComments = reviewComments?.filter((comment) => {
                        if (!comment?.body) {
                            return true;
                        }

                        const isStartMessage =
                            startMessageContent &&
                            comment.body === startMessageContent;
                        const isEndMessage =
                            endMessageContent &&
                            comment.body === endMessageContent;

                        return !isStartMessage && !isEndMessage;
                    });
                }
            }

            if (!reviewComments || reviewComments?.length < 1) {
                return false;
            }

            const isEveryReviewCommentResolved = reviewComments?.every(
                (reviewComment) => reviewComment?.isResolved,
            );

            if (isEveryReviewCommentResolved) {
                const hasInProgressReview =
                    await this.hasInProgressReviewExecution({
                        teamAutomationId,
                        pullRequestNumber: prNumber,
                        repositoryId: repository?.id,
                    });

                if (hasInProgressReview) {
                    this.logger.log({
                        message:
                            'Skipping approval due to in-progress review execution in final check',
                        context: CheckIfPRCanBeApprovedCronProvider.name,
                        metadata: {
                            organizationAndTeamData,
                            prNumber,
                            repository: {
                                name: repository?.name,
                                id: repository?.id,
                            },
                            teamAutomationId,
                        },
                    });
                    return false;
                }

                this.logger.log({
                    message: `Is every review comment resolved for PR#${prNumber}`,
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: {
                        isEveryReviewCommentResolved,
                        organizationAndTeamData,
                        prNumber,
                        repository: {
                            name: repository?.name,
                            id: repository?.id,
                        },
                    },
                });

                await this.codeManagementService.checkIfPullRequestShouldBeApproved(
                    {
                        organizationAndTeamData,
                        prNumber,
                        repository: {
                            name: repository?.name,
                            id: repository?.id,
                        },
                    },
                    platformType,
                );
                return true;
            }
        } catch (error) {
            this.logger.error({
                message: 'Error in shouldApprovePR',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                metadata: {
                    organizationAndTeamData,
                    platformType,
                    prNumber: pr.number,
                    repository: {
                        name: repository?.name,
                        id: repository?.id,
                    },
                },
                error,
            });

            return false;
        }
    }

    private async hasInProgressReviewExecution({
        teamAutomationId,
        pullRequestNumber,
        repositoryId,
    }: {
        teamAutomationId: string;
        pullRequestNumber: number;
        repositoryId?: string;
    }): Promise<boolean> {
        if (!teamAutomationId || typeof pullRequestNumber !== 'number') {
            return false;
        }

        const inProgressExecutions = await this.automationExecutionService.find(
            {
                teamAutomation: { uuid: teamAutomationId },
                pullRequestNumber,
                ...(repositoryId ? { repositoryId } : {}),
                status: AutomationStatus.IN_PROGRESS,
            },
        );

        return (
            Array.isArray(inProgressExecutions) &&
            inProgressExecutions.length > 0
        );
    }

    private getLastAnalyzedCommitSha(lastAnalyzedCommit?: any): string | null {
        if (!lastAnalyzedCommit) {
            return null;
        }

        if (typeof lastAnalyzedCommit === 'string') {
            return lastAnalyzedCommit;
        }

        if (typeof lastAnalyzedCommit === 'object') {
            if (lastAnalyzedCommit.sha) {
                return lastAnalyzedCommit.sha;
            }
            if (lastAnalyzedCommit.commitSha) {
                return lastAnalyzedCommit.commitSha;
            }
            if (lastAnalyzedCommit.commit?.sha) {
                return lastAnalyzedCommit.commit.sha;
            }
        }

        return null;
    }

    private async setPullRequestMessagesConfig(
        repository: {
            id: string;
            name: string;
        },
        organizationAndTeamData: OrganizationAndTeamData,
        codeReviewConfig?: CodeReviewConfig,
    ): Promise<IPullRequestMessages | null> {
        if (!repository?.id || !organizationAndTeamData?.organizationId) {
            this.logger.warn({
                message:
                    'Missing required data for pull request messages config',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                metadata: {
                    hasRepositoryId: !!repository?.id,
                    hasOrganizationId:
                        !!organizationAndTeamData?.organizationId,
                },
            });
            return null;
        }

        const repositoryId = repository.id;
        const organizationId = organizationAndTeamData.organizationId;
        const directoryId = codeReviewConfig?.directoryId;
        const configLevel = codeReviewConfig?.configLevel;

        // Generate cache key based on lookup hierarchy
        const cacheKey = `${organizationId}:${repositoryId}:${directoryId || 'null'}:${configLevel || 'null'}`;

        // Check cache first
        if (this.pullRequestMessagesCache.has(cacheKey)) {
            return this.pullRequestMessagesCache.get(cacheKey);
        }

        let pullRequestMessagesConfig = null;

        // Hierarchical fallback: DIRECTORY → REPOSITORY → GLOBAL
        if (configLevel === ConfigLevel.DIRECTORY) {
            if (!directoryId) {
                this.logger.warn({
                    message:
                        'Directory configLevel missing directoryId, skipping DIRECTORY lookup',
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: { repositoryId, organizationId },
                });
            } else {
                pullRequestMessagesConfig =
                    await this.pullRequestMessagesService.findOne({
                        organizationId,
                        repositoryId,
                        directoryId,
                        configLevel: ConfigLevel.DIRECTORY,
                    });
            }
        }

        if (!pullRequestMessagesConfig) {
            pullRequestMessagesConfig =
                await this.pullRequestMessagesService.findOne({
                    organizationId,
                    repositoryId,
                    configLevel: ConfigLevel.REPOSITORY,
                });
        }

        if (!pullRequestMessagesConfig) {
            pullRequestMessagesConfig =
                await this.pullRequestMessagesService.findOne({
                    organizationId,
                    configLevel: ConfigLevel.GLOBAL,
                });
        }

        // Store in cache (even if null)
        this.pullRequestMessagesCache.set(cacheKey, pullRequestMessagesConfig);

        return pullRequestMessagesConfig;
    }
}
