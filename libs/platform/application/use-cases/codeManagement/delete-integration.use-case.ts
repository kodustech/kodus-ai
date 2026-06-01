import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { AUTH_INTEGRATION_SERVICE_TOKEN } from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { INTEGRATION_SERVICE_TOKEN } from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { AuthIntegrationService } from '@libs/integrations/infrastructure/adapters/services/authIntegration.service';
import { IntegrationService } from '@libs/integrations/infrastructure/adapters/services/integration.service';
import { IntegrationConfigService } from '@libs/integrations/infrastructure/adapters/services/integrationConfig.service';
import {
    KODUS_MCP_GITHUB_ISSUES_INTEGRATION_ID,
    MCPManagerService,
} from '@libs/mcp-server/services/mcp-manager.service';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class DeleteIntegrationUseCase {
    private readonly logger = createLogger(DeleteIntegrationUseCase.name);
    constructor(
        private readonly codeManagementService: CodeManagementService,
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IntegrationService,
        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: AuthIntegrationService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IntegrationConfigService,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly eventEmitter: EventEmitter2,
        private readonly mcpManagerService: MCPManagerService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: {
                organization: { uuid: string };
                uuid: string;
                email: string;
            };
        },
    ) {}

    async execute(params: {
        organizationId: string;
        teamId: string;
    }): Promise<void> {
        const integration = await this.integrationService.findOne({
            organization: { uuid: params.organizationId },
            team: { uuid: params.teamId },
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            status: true,
        });

        if (!integration) {
            return;
        }

        if (integration.platform === PlatformType.GITHUB) {
            const organizationGithubIntegrations =
                await this.integrationService.find({
                    organization: { uuid: params.organizationId },
                    integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
                    platform: PlatformType.GITHUB,
                    status: true,
                });

            if ((organizationGithubIntegrations ?? []).length === 1) {
                await this.mcpManagerService.deleteConnectionByIntegrationId(
                    {
                        organizationId: params.organizationId,
                    },
                    KODUS_MCP_GITHUB_ISSUES_INTEGRATION_ID,
                );
            }
        }

        try {
            await this.codeManagementService.deleteWebhook({
                organizationAndTeamData: {
                    organizationId: params.organizationId,
                    teamId: params.teamId,
                },
            });
        } catch (error) {
            this.logger.error({
                message:
                    'Error deleting webhooks from remote provider — proceeding with local cleanup',
                context: DeleteIntegrationUseCase.name,
                error,
                metadata: {
                    organizationId: params.organizationId,
                    teamId: params.teamId,
                },
            });
        }

        const integrationConfig = await this.integrationConfigService.findOne({
            configKey: IntegrationConfigKey.REPOSITORIES,
            integration: { uuid: integration.uuid },
            team: { uuid: params.teamId },
        });

        if (integrationConfig) {
            await this.integrationConfigService.delete(integrationConfig.uuid);
        }

        await this.createOrUpdateParametersUseCase.execute(
            ParametersKey.CENTRALIZED_CONFIG,
            {
                enabled: false,
                repository: null,
                activePullRequest: null,
            },
            {
                organizationId: params.organizationId,
                teamId: params.teamId,
            },
        );

        this.eventEmitter.emit(AuditLogEvents.INTEGRATION, {
            organizationAndTeamData: {
                organizationId: params.organizationId,
                teamId: params.teamId,
            },
            userInfo: {
                userId: this.request.user.uuid,
                userEmail: this.request.user.email,
            },
            integration,
            actionType: ActionType.DELETE,
        });

        await this.integrationService.delete(integration.uuid);

        await this.authIntegrationService.delete(
            integration.authIntegration.uuid,
        );
    }
}
