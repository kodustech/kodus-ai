import { Inject, Injectable } from '@nestjs/common';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { RunCodeReviewAutomationUseCase } from '../../automation/runCodeReview.use-case';
import { ChatWithKodyFromGitUseCase } from './chatWithKodyFromGit.use-case';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { SavePullRequestUseCase } from '../../pullRequests/save.use-case';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { getMappedPlatform } from '@/shared/utils/webhooks';
import { IWebhookBitbucketPullRequestEvent } from '@/core/domain/platformIntegrations/types/webhooks/webhooks-bitbucket.type';
import {
    PULL_REQUESTS_SERVICE_TOKEN,
    IPullRequestsService,
} from '@/core/domain/pullRequests/contracts/pullRequests.service.contracts';
import { BitbucketService } from '@/core/infrastructure/adapters/services/bitbucket/bitbucket.service';
import {
    INTEGRATION_CONFIG_SERVICE_TOKEN,
    IIntegrationConfigService,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

@Injectable()
export class ReceiveWebhookUseCase implements IUseCase {
    constructor(
        private readonly logger: PinoLoggerService,
        private readonly runCodeReviewAutomationUseCase: RunCodeReviewAutomationUseCase,
        private readonly chatWithKodyFromGitUseCase: ChatWithKodyFromGitUseCase,
        private readonly savePullRequestUseCase: SavePullRequestUseCase,
        private readonly codeManagement: CodeManagementService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        private readonly bitbuckerService: BitbucketService,
    ) {}

    public async execute(params: {
        payload: any;
        event: string;
        platformType: PlatformType;
    }): Promise<void> {
        try {
            switch (params?.event) {
                case 'pull_request': // GitHub
                    await this.savePullRequestUseCase.execute(params);
                    this.runCodeReviewAutomationUseCase.execute(params);
                    break;

                case 'Merge Request Hook': // GitLab
                    if (this.shouldTriggerCodeReviewForGitLab(params)) {
                        await this.savePullRequestUseCase.execute(params);
                        this.runCodeReviewAutomationUseCase.execute(params);
                    }
                    break;

                case 'pullrequest:created': // Bitbucket
                case 'pullrequest:updated':
                    if (
                        await this.shouldTriggerCodeReviewForBitbucket(
                            params.payload,
                        )
                    ) {
                        await this.savePullRequestUseCase.execute(params);
                        this.runCodeReviewAutomationUseCase.execute(params);
                    }
                    break;
                case 'pullrequest:rejected':
                case 'pullrequest:fulfilled':
                    if (
                        await this.shouldTriggerCodeReviewForBitbucket(
                            params.payload,
                        )
                    ) {
                        await this.savePullRequestUseCase.execute(params);
                    }
                    break;

                case 'pullrequest:comment_created':
                    this.isStartCommand(params);
                    break;

                case 'issue_comment':
                    this.isStartCommand(params);
                    break;
                case 'pull_request_review_comment':
                case 'Note Hook':
                    if (
                        params.payload?.object_attributes?.action ===
                            'create' &&
                        !params.payload?.object_attributes?.change_position &&
                        !params.payload?.object_attributes?.type
                    ) {
                        this.isStartCommand(params);
                    } else {
                        this.chatWithKodyFromGitUseCase.execute(params);
                    }
                    break;

                // Azure DevOps events
                case 'git.pullrequest.created':
                case 'git.pullrequest.updated':
                    await this.savePullRequestUseCase.execute(params);
                    this.runCodeReviewAutomationUseCase.execute(params);
                    break;
                case 'git.pullrequest.merge.attempted':
                    await this.savePullRequestUseCase.execute(params);
                    break;
                case 'ms.vss-code.git-pullrequest-comment-event':
                    const comment = params.payload?.resource?.comment?.content;
                    const pullRequestId =
                        params.payload?.resource?.pullRequest?.pullRequestId;

                    if (comment && this.isAzureDevOpsStartCommand(comment)) {
                        const updatedParams = {
                            ...params,
                            payload: {
                                ...params.payload,
                                action: 'synchronize',
                                origin: 'command',
                            },
                        };

                        await this.savePullRequestUseCase.execute(
                            updatedParams,
                        );
                        await this.runCodeReviewAutomationUseCase.execute(
                            updatedParams,
                        );
                    } else {
                        // Processar comentário normal
                        this.chatWithKodyFromGitUseCase.execute(params);
                    }
                    break;

                default:
                    this.logger.warn({
                        message: `Evento não tratado: ${params?.event}`,
                        context: ReceiveWebhookUseCase.name,
                        metadata: {
                            event: params?.event,
                        },
                    });
            }
        } catch (error) {
            this.logger.error({
                message: 'Error processing webhook',
                context: ReceiveWebhookUseCase.name,
                error: error,
                metadata: {
                    eventName: params.event,
                    platformType: params.platformType,
                },
            });
        }
    }

    private async isStartCommand(params: {
        payload: any;
        event: string;
        platformType: PlatformType;
    }) {
        const { payload, event, platformType } = params;

        const mappedPlatform = getMappedPlatform(platformType);
        if (!mappedPlatform) {
            return;
        }

        const comment = mappedPlatform.mapComment({ payload });
        if (!comment || !comment.body || payload?.action === 'deleted') {
            return;
        }

        const commandPattern = /@kody\s+start-review/i;
        const isStartCommand = commandPattern.test(comment.body);

        const pullRequest = mappedPlatform.mapPullRequest({ payload });

        if (isStartCommand) {
            this.logger.log({
                message: `@kody start command detected in PR#${pullRequest?.number}`,
                context: ReceiveWebhookUseCase.name,
                metadata: {
                    ...params,
                },
            });

            let pullRequestData = null;
            if (
                platformType === PlatformType.GITHUB &&
                !payload?.pull_request &&
                payload?.issue &&
                payload?.issue?.number
            ) {
                const repository = {
                    id: payload.repository.id,
                    name: payload.repository.name,
                };

                const teamData =
                    await this.runCodeReviewAutomationUseCase.findTeamWithActiveCodeReview(
                        {
                            repository,
                        },
                    );

                if (teamData?.organizationAndTeamData) {
                    pullRequestData =
                        await this.codeManagement.getPullRequestDetails({
                            organizationAndTeamData:
                                teamData?.organizationAndTeamData,
                            repository,
                            prNumber: payload.issue.number,
                        });
                }
            }

            const updatedParams = {
                ...params,
                payload: {
                    ...payload,
                    action: 'synchronize',
                    origin: 'command',
                    pull_request:
                        pullRequestData || pullRequest || payload?.pull_request,
                },
            };

            await this.savePullRequestUseCase.execute(updatedParams);
            await this.runCodeReviewAutomationUseCase.execute(updatedParams);
            return;
        }
        return;
    }

    private shouldTriggerCodeReviewForGitLab(params: any): boolean {
        const objectAttributes = params.payload?.object_attributes || {};
        const changes = params.payload?.changes || {};

        // Verify if it's a new MR
        if (objectAttributes.action === 'open') {
            return true;
        }

        // Verify if it's a new commit
        const lastCommitId = objectAttributes.last_commit?.id;
        const oldRev = objectAttributes.oldrev;

        if (lastCommitId && oldRev && lastCommitId !== oldRev) {
            return true;
        }

        // Verify if it's a merge
        if (
            objectAttributes.state === 'merged' ||
            objectAttributes.action === 'merge'
        ) {
            return true;
        }

        // Ignore if it's an update to the description
        if (objectAttributes.action === 'update' && changes.description) {
            return false;
        }

        // For all other cases, return false
        return false;
    }

    private isBitbucketPullRequestEvent(
        event: any,
    ): event is IWebhookBitbucketPullRequestEvent {
        const pullRequest = event?.pullrequest;
        const actor = event?.actor;
        const repository = event?.repository;
        const areUndefined =
            pullRequest === undefined ||
            actor === undefined ||
            repository === undefined;

        if (areUndefined) {
            return false;
        }

        return true;
    }

    // We can't know when a Bitbucket PR was updated due to a new commit or something else like new description via the webhook alone
    private async shouldTriggerCodeReviewForBitbucket(
        payload: any,
    ): Promise<boolean> {
        if (!this.isBitbucketPullRequestEvent(payload)) {
            return false;
        }

        const { pullrequest, repository } = payload;
        const repoId = repository.uuid.slice(1, repository.uuid.length - 1);

        const configs =
            await this.integrationConfigService.findIntegrationConfigWithTeams(
                IntegrationConfigKey.REPOSITORIES,
                repoId,
            );

        if (!configs || !configs.length) {
            return false;
        }

        const organizationAndTeamData: OrganizationAndTeamData = configs.map(
            (config) => ({
                organizationId: config.team.organization.uuid,
                teamId: config.team.uuid,
            }),
        )[0];

        const pullRequestCommits =
            await this.bitbuckerService.getCommitsForPullRequestForCodeReview({
                organizationAndTeamData,
                repository: {
                    id: repoId,
                    name: repository.name,
                },
                prNumber: pullrequest.id,
            });

        const storedPR =
            await this.pullRequestsService.findByNumberAndRepository(
                pullrequest.id,
                repository.name,
            );

        if (storedPR) {
            const prCommit = pullRequestCommits[0];
            const storedPRCommitHashes = storedPR.commits?.map(
                (commit) => commit.sha,
            );
            if (storedPRCommitHashes.includes(prCommit.sha)) {
                return false;
            }
        }

        switch (pullrequest.state) {
            case 'OPEN':
                return true;
            case 'MERGED':
                return true;
            case 'DECLINED':
                return true;
            default:
                return false;
        }
    }

    /**
     * Verifica se um comentário do Azure DevOps contém o comando para iniciar review
     */
    private isAzureDevOpsStartCommand(comment: string): boolean {
        const commandPattern = /@kody\s+start-review/i;
        return commandPattern.test(comment);
    }
}
