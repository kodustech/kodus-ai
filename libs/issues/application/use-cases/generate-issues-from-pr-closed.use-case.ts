import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import { KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/KodyIssuesManagement.contract';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { getMappedPlatform } from '@libs/common/utils/webhooks';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    contextToGenerateIssues,
    IRepositoryToIssues,
} from '@libs/issues/domain/interfaces/kodyIssuesManagement.interface';
import { KodyIssuesManagementService } from '@libs/issues/infrastructure/adapters/service/kodyIssuesManagement.service';
import { stripCurlyBracesFromUUIDs } from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-bitbucket.type';
import {
    IMappedPullRequest,
    IMappedRepository,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-common.type';

@Injectable()
export class GenerateIssuesFromPrClosedUseCase implements IUseCase {
    private readonly logger = createLogger(
        GenerateIssuesFromPrClosedUseCase.name,
    );
    constructor(
        @Inject(KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN)
        private readonly kodyIssuesManagementService: KodyIssuesManagementService,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
    ) {}

    async execute(params: any): Promise<void> {
        this.logger.log({
            message: 'Starting issue generation from closed PR',
            context: GenerateIssuesFromPrClosedUseCase.name,
            metadata: {
                platformType: params?.platformType,
                event: params?.event,
            },
        });

        const normalizedPayload = await this.normalizePayload(params);

        if (!normalizedPayload) {
            this.logger.warn({
                message:
                    'Skipping issue generation: failed to normalize webhook payload',
                context: GenerateIssuesFromPrClosedUseCase.name,
                metadata: {
                    platformType: params?.platformType,
                },
            });
            return;
        }

        const prData = await this.fillProperties(normalizedPayload);

        if (!prData.context.organizationAndTeamData) {
            this.logger.warn({
                message: `Skipping issue generation: organizationAndTeamData not found for repository ${prData.context.repository?.name}`,
                context: GenerateIssuesFromPrClosedUseCase.name,
                metadata: {
                    prNumber: prData.context.pullRequest?.number,
                    repositoryId: prData.context.repository?.id,
                    repositoryName: prData.context.repository?.name,
                    platformType: params?.platformType,
                },
            });
            return;
        }

        try {
            if (params?.platformType === PlatformType.AZURE_REPOS) {
                if (normalizedPayload?.pullRequest?.status !== 'completed') {
                    return;
                }
            }

            const pr =
                await this.pullRequestService.findByNumberAndRepositoryName(
                    prData.context.pullRequest.number,
                    prData.context.repository.name,
                    {
                        organizationId:
                            prData.context.organizationAndTeamData
                                .organizationId,
                    },
                );

            if (!pr) {
                this.logger.warn({
                    message: `Skipping issue generation: PR #${prData.context.pullRequest.number} not found in database for repository ${prData.context.repository.name}`,
                    context: GenerateIssuesFromPrClosedUseCase.name,
                    metadata: {
                        prNumber: prData.context.pullRequest.number,
                        repositoryId: prData.context.repository.id,
                        repositoryName: prData.context.repository.name,
                        organizationId:
                            prData.context.organizationAndTeamData
                                .organizationId,
                    },
                });
                return;
            }

            const prFiles = pr.files;

            if (prFiles.length === 0) {
                this.logger.warn({
                    message: `Skipping issue generation: PR #${prData.context.pullRequest.number} has no files in database for repository ${prData.context.repository.name}`,
                    context: GenerateIssuesFromPrClosedUseCase.name,
                    metadata: {
                        prNumber: prData.context.pullRequest.number,
                        repositoryId: prData.context.repository.id,
                        repositoryName: prData.context.repository.name,
                        organizationId:
                            prData.context.organizationAndTeamData
                                .organizationId,
                    },
                });
                return;
            }

            await this.kodyIssuesManagementService.processClosedPr({
                organizationAndTeamData: prData.context.organizationAndTeamData,
                pullRequest: prData.context.pullRequest,
                repository: prData.context.repository,
                prFiles: prFiles,
            });

            await this.kodyIssuesManagementService.clearIssuesCache(
                prData.context?.organizationAndTeamData?.organizationId,
            );
        } catch (error) {
            this.logger.error({
                context: GenerateIssuesFromPrClosedUseCase.name,
                serviceName: GenerateIssuesFromPrClosedUseCase.name,
                message: `Error processing closed pull request #${prData.context.pullRequest.number}: ${error.message}`,
                metadata: {
                    prNumber: prData.context.pullRequest.number,
                    repositoryId: prData.context.repository.id,
                    organizationId:
                        prData.context?.organizationAndTeamData?.organizationId,
                },
                error,
            });
        }
    }

    private async normalizePayload(params: any): Promise<{
        pullRequest: IMappedPullRequest;
        repository: IMappedRepository;
        platformType: PlatformType;
    } | null> {
        const { payload, platformType } = params;

        const sanitizedPayload =
            platformType === PlatformType.BITBUCKET
                ? stripCurlyBracesFromUUIDs(payload)
                : payload;

        const mappedPlatform = getMappedPlatform(platformType);

        if (!mappedPlatform) {
            this.logger.warn({
                message: `Skipping issue generation: no mapped platform found for type ${platformType}`,
                context: GenerateIssuesFromPrClosedUseCase.name,
                metadata: { platformType },
            });
            return;
        }

        const pullRequest = mappedPlatform.mapPullRequest({
            payload: sanitizedPayload,
        });

        if (
            !pullRequest ||
            !pullRequest?.number ||
            !pullRequest?.repository ||
            !pullRequest?.user
        ) {
            this.logger.warn({
                message:
                    'Skipping issue generation: invalid or incomplete pull request data from webhook payload',
                context: GenerateIssuesFromPrClosedUseCase.name,
                metadata: {
                    platformType,
                    hasPullRequest: !!pullRequest,
                    hasNumber: !!pullRequest?.number,
                    hasRepository: !!pullRequest?.repository,
                    hasUser: !!pullRequest?.user,
                },
            });
            return;
        }

        const repository = mappedPlatform.mapRepository({
            payload: sanitizedPayload,
        });

        if (!repository || !repository?.id || !repository?.name) {
            this.logger.warn({
                message:
                    'Skipping issue generation: invalid or incomplete repository data from webhook payload',
                context: GenerateIssuesFromPrClosedUseCase.name,
                metadata: {
                    platformType,
                    hasRepository: !!repository,
                    hasId: !!repository?.id,
                    hasName: !!repository?.name,
                },
            });
            return;
        }

        return {
            pullRequest,
            repository,
            platformType,
        };
    }

    private async fillProperties(params: any): Promise<{
        context: contextToGenerateIssues;
    }> {
        const pullRequest = params?.pullRequest;
        const repositoryId = params?.repository?.id?.toString();
        const repositoryName = params?.repository?.name;
        const repositoryFullName = params?.repository?.fullName;
        const platformType = params?.platformType;

        const organizationAndTeamData = await this.getOrganizationAndTeamData(
            Number(pullRequest.number),
            params?.repository,
            platformType,
        );

        return {
            context: {
                pullRequest,
                repository: {
                    id: repositoryId,
                    name: repositoryName,
                    full_name: repositoryFullName,
                    platform: platformType,
                },
                organizationAndTeamData,
            },
        };
    }

    private async getOrganizationAndTeamData(
        prNumber: number,
        repository: IRepositoryToIssues,
        platformType: PlatformType,
    ): Promise<OrganizationAndTeamData | null> {
        const configs =
            await this.integrationConfigService.findIntegrationConfigWithTeams(
                IntegrationConfigKey.REPOSITORIES,
                repository.id,
                platformType,
            );

        if (!configs || !configs.length) {
            this.logger.warn({
                message: `No repository configuration found for repository ${repository?.name}`,
                context: GenerateIssuesFromPrClosedUseCase.name,
                metadata: {
                    prNumber: prNumber,
                    repositoryId: repository?.id,
                    repositoryName: repository?.name,
                },
            });

            return null;
        }

        const organizationAndTeamData: OrganizationAndTeamData[] = configs.map(
            (config) => ({
                organizationId: config.team.organization.uuid,
                teamId: config.team.uuid,
            }),
        );

        return organizationAndTeamData?.[0] || null;
    }
}
