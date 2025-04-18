import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import {
    TEAM_AUTOMATION_SERVICE_TOKEN,
    ITeamAutomationService,
} from '@/core/domain/automation/contracts/team-automation.service';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import {
    EXECUTE_AUTOMATION_SERVICE_TOKEN,
    IExecuteAutomationService,
} from '@/shared/domain/contracts/execute.automation.service.contracts';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { getMappedPlatform } from '@/shared/utils/webhooks';
import { stripCurlyBracesFromUUIDs } from '@/core/domain/platformIntegrations/types/webhooks/webhooks-bitbucket.type';

@Injectable()
export class RunCodeReviewAutomationUseCase {
    constructor(
        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(EXECUTE_AUTOMATION_SERVICE_TOKEN)
        private readonly executeAutomation: IExecuteAutomationService,

        private readonly codeManagement: CodeManagementService,

        private logger: PinoLoggerService,
    ) { }

    async execute(params: {
        payload: any;
        event: string;
        platformType: PlatformType;
        automationName?: string;
    }) {
        let organizationAndTeamData = null;

        try {
            const { payload, event, platformType } = params;

            if (!this.shouldRunAutomation(payload, platformType)) {
                return;
            }

            const mappedPlatform = getMappedPlatform(platformType);
            if (!mappedPlatform) {
                return;
            }

            const sanitizedPayload =
                platformType === PlatformType.BITBUCKET
                    ? stripCurlyBracesFromUUIDs(payload)
                    : payload;

            const action = mappedPlatform.mapAction({
                payload: sanitizedPayload,
                event: event,
            });
            if (!action) {
                return;
            }

            const repository = mappedPlatform.mapRepository({
                payload: sanitizedPayload,
            });
            if (!repository) {
                return;
            }

            const teamWithAutomation = await this.findTeamWithActiveCodeReview({
                repository,
            });

            if (!teamWithAutomation) {
                return;
            }

            const { organizationAndTeamData: teamData, automationId } =
                teamWithAutomation;
            organizationAndTeamData = teamData;

            let pullRequestData = null;
            const pullRequest = mappedPlatform.mapPullRequest({
                payload: sanitizedPayload,
            });
            if (!pullRequest) {
                // try to get the PR details from the code management when it's a github issue
                if (platformType === PlatformType.GITHUB) {
                    pullRequestData =
                        await this.codeManagement.getPullRequestDetails({
                            organizationAndTeamData,
                            repository: {
                                id: repository.id,
                                name: repository.name,
                            },
                            prNumber: sanitizedPayload?.issue?.number,
                        });
                }
                // if it's still not possible to get the PR details, return
                if (!pullRequestData) {
                    return;
                }
            }
            pullRequestData = pullRequestData ?? pullRequest;

            let repositoryData = repository;
            // Only github provides the language in the webhook, so for the others try to get it
            if (
                !repositoryData.language &&
                platformType !== PlatformType.GITHUB
            ) {
                repositoryData = {
                    ...repository,
                    language: await this.codeManagement.getLanguageRepository({
                        organizationAndTeamData,
                        repository: {
                            id: repository.id,
                            name: repository.name,
                        },
                    }),
                };
            }

            this.logger.log({
                message: `RunCodeReviewAutomationUseCase PR#${pullRequestData?.number}`,
                context: RunCodeReviewAutomationUseCase.name,
                metadata: {
                    organizationAndTeamData,
                    repository: repositoryData,
                    pullRequest: pullRequestData,
                    branch: pullRequestData?.head?.ref,
                    codeManagementEvent: event,
                    platformType: platformType,
                    origin: sanitizedPayload?.origin,
                },
            });

            return await this.executeAutomation.executeStrategy(
                AutomationType.AUTOMATION_CODE_REVIEW,
                {
                    organizationAndTeamData,
                    teamAutomationId: automationId,
                    repository: repositoryData,
                    pullRequest: pullRequestData,
                    branch: pullRequestData?.head?.ref,
                    codeManagementEvent: event,
                    platformType: platformType,
                    origin: sanitizedPayload?.origin,
                    action,
                },
            );
        } catch (error) {
            this.logger.error({
                message: 'Error executing code review automation',
                context: RunCodeReviewAutomationUseCase.name,
                error: error,
                metadata: {
                    automationName: params.automationName,
                    teamId: organizationAndTeamData?.teamId,
                },
            });
        }
    }

    private shouldRunAutomation(payload: any, platformType: PlatformType) {
        const allowedActions = ['opened', 'synchronize', 'open', 'update', 'git.pullrequest.updated', 'git.pullrequest.created'];
        const currentAction =
            payload?.action || payload?.object_attributes?.action || payload?.eventType;

        const isMerged = payload?.object_attributes?.state === 'merged';
        const isCommand = payload?.origin === 'command';

        // bitbucket has already been handled in the webhook validation
        if (
            !isCommand &&
            platformType !== PlatformType.BITBUCKET &&
            (!allowedActions.includes(currentAction) || isMerged)
        ) {
            return false;
        }

        return true;
    }

    private async getAutomation() {
        const automation = (
            await this.automationService.find({
                automationType: AutomationType.AUTOMATION_CODE_REVIEW,
            })
        )[0];

        if (!automation) {
            this.logger.warn({
                message: 'No automation found',
                context: RunCodeReviewAutomationUseCase.name,
                metadata: {
                    automationName: 'Code Review',
                },
            });
            throw new Error('No automation found');
        }

        return automation;
    }

    private async getTeamAutomations(automationUuid: string, teamId: string) {
        const teamAutomations = await this.teamAutomationService.find({
            automation: { uuid: automationUuid },
            status: true,
            team: { uuid: teamId },
        });

        if (!teamAutomations || teamAutomations?.length <= 0) {
            this.logger.warn({
                message: 'No active team automation found',
                context: RunCodeReviewAutomationUseCase.name,
                metadata: {
                    automation: automationUuid,
                    teamId: teamId,
                },
            });
            return null;
        }

        return teamAutomations;
    }

    async findTeamWithActiveCodeReview(params: {
        repository: { id: string; name: string };
    }): Promise<{
        organizationAndTeamData: OrganizationAndTeamData;
        automationId: string;
    } | null> {
        try {
            if (!params?.repository?.id) {
                return null;
            }

            const configs =
                await this.integrationConfigService.findIntegrationConfigWithTeams(
                    IntegrationConfigKey.REPOSITORIES,
                    params.repository.id,
                );

            if (!configs?.length) {
                this.logger.warn({
                    message: 'No repository configuration found',
                    context: RunCodeReviewAutomationUseCase.name,
                    metadata: {
                        repositoryName: params.repository?.name,
                    },
                });

                return null;
            }

            const automation = await this.getAutomation();

            for (const config of configs) {
                const automations = await this.getTeamAutomations(
                    automation.uuid,
                    config.team.uuid,
                );

                if (automations?.length) {
                    return {
                        organizationAndTeamData: {
                            organizationId: config.team.organization.uuid,
                            teamId: config.team.uuid,
                        },
                        automationId: automations[0].uuid,
                    };
                }
            }

            return null;
        } catch (error) {
            throw new BadRequestException(error);
        }
    }
}
