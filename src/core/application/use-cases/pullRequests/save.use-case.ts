import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { stripCurlyBracesFromUUIDs } from '@/core/domain/platformIntegrations/types/webhooks/webhooks-bitbucket.type';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@/core/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { getMappedPlatform } from '@/shared/utils/webhooks';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class SavePullRequestUseCase {
    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,

        private readonly codeManagement: CodeManagementService,

        private readonly logger: PinoLoggerService,
    ) { }

    public async execute(params: {
        payload: any;
        platformType: PlatformType;
        event: string;
    }): Promise<void> {
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

            let pullRequest = mappedPlatform.mapPullRequest({
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

            try {
                const configs =
                    await this.integrationConfigService.findIntegrationConfigWithTeams(
                        IntegrationConfigKey.REPOSITORIES,
                        repository.id,
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

                const organizationAndTeamData: OrganizationAndTeamData[] =
                    configs.map((config) => ({
                        organizationId: config.team.organization.uuid,
                        teamId: config.team.uuid,
                    }));

                const changedFiles =
                    await this.codeManagement.getFilesByPullRequestId(
                        {
                            organizationAndTeamData:
                                organizationAndTeamData?.[0],
                            prNumber: pullRequest?.number,
                            repository,
                        },
                        platformType,
                    );

                const relevantUsers = mappedPlatform.mapUsers({
                    payload: sanitizedPayload,
                });

                let pullRequestWithUserData: any = {
                    ...pullRequest,
                    ...relevantUsers,
                };

                const pullRequestCommits =
                    await this.codeManagement.getCommitsForPullRequestForCodeReview(
                        {
                            organizationAndTeamData: {
                                ...organizationAndTeamData?.[0],
                            },
                            repository: {
                                id: repository.id,
                                name: repository.name,
                            },
                            prNumber: pullRequestWithUserData.number,
                        },
                    );

                try {
                    await this.pullRequestsService.aggregateAndSaveDataStructure(
                        pullRequestWithUserData,
                        repository,
                        changedFiles,
                        [],
                        [],
                        platformType,
                        organizationAndTeamData?.[0]?.organizationId,
                        pullRequestCommits,
                    );
                } catch (error) {
                    this.logger.error({
                        message: `Failed to aggregate and save pull request data for PR#${pullRequestWithUserData?.number}`,
                        context: SavePullRequestUseCase.name,
                        error,
                        metadata: {
                            repository: repository?.name,
                            pullRequest: pullRequestWithUserData?.number,
                            organizationAndTeamData:
                                organizationAndTeamData?.[0],
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
            'review_requested',
            'review_request_removed',
            'assigned',
            'unassigned',
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
            platformType === PlatformType.BITBUCKET
        );
    }


}
