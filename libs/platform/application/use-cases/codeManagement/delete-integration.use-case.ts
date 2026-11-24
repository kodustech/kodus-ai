import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import { primaryConnectionOf } from '@libs/integrations/domain/integrations/utils/primary-connection';
import { createLogger } from '@libs/core/log/logger';
import {
    BadRequestException,
    Inject,
    Injectable,
    Optional,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { AUTH_INTEGRATION_SERVICE_TOKEN } from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { INTEGRATION_SERVICE_TOKEN } from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { AuthIntegrationService } from '@libs/integrations/infrastructure/adapters/services/authIntegration.service';
import { IntegrationService } from '@libs/integrations/infrastructure/adapters/services/integration.service';
import { IntegrationConfigService } from '@libs/integrations/infrastructure/adapters/services/integrationConfig.service';
import {
    KODUS_ISSUES_INTEGRATION_ID,
    MCPManagerService,
} from '@libs/mcp-server/services/mcp-manager.service';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
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
        @Optional()
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService?: IParametersService,
        @Optional()
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService?: ILicenseService,
    ) {}

    async execute(params: {
        organizationId: string;
        teamId: string;
        connectionId?: string;
    }): Promise<void> {
        const workspaceScope = {
            organization: { uuid: params.organizationId },
            team: { uuid: params.teamId },
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            status: true,
        };

        let integration;
        if (params.connectionId) {
            integration = await this.integrationService.findOne({
                ...workspaceScope,
                uuid: params.connectionId,
            });
        } else {
            const connections =
                (await this.integrationService.find(workspaceScope)) ?? [];
            if (connections.length > 1) {
                throw new BadRequestException(
                    'This workspace has several Git connections: choose the one to reset.',
                );
            }
            integration = connections[0];
        }

        if (!integration) {
            return;
        }

        const organizationAndTeamData = {
            organizationId: params.organizationId,
            teamId: params.teamId,
            integrationId: integration.uuid,
        };

        const otherConnections = (
            (await this.integrationService.find({
                organization: { uuid: params.organizationId },
                integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
                status: true,
            })) ?? []
        ).filter((connection) => connection.uuid !== integration.uuid);

        // The generic issues MCP reuses the organization's code-management
        // connection, so it goes with the last one; while another remains it
        // keeps serving the organization.
        if (!otherConnections.length) {
            await this.mcpManagerService.deleteConnectionByIntegrationId(
                { organizationId: params.organizationId },
                KODUS_ISSUES_INTEGRATION_ID,
            );
        }

        try {
            await this.codeManagementService.deleteWebhook({
                organizationAndTeamData,
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

        // Delete every config tied to this integration (REPOSITORIES,
        // INSTALLATION_GITHUB, CODE_MANAGEMENT_PAT, ...). Any row left behind
        // violates the integration_configs.integration_id FK (ON DELETE NO
        // ACTION) and aborts the integration delete below, leaving a stale
        // active integration that breaks future reconnects.
        const integrationConfigs = await this.integrationConfigService.find({
            integration: { uuid: integration.uuid },
        });

        const connectionRepositoryIds = new Set(
            (integrationConfigs ?? [])
                .filter(
                    (config) =>
                        config.configKey === IntegrationConfigKey.REPOSITORIES,
                )
                .flatMap((config) =>
                    Array.isArray(config.configValue) ? config.configValue : [],
                )
                .map((repository: { id: string | number }) =>
                    String(repository?.id),
                ),
        );

        for (const integrationConfig of integrationConfigs ?? []) {
            await this.integrationConfigService.delete(integrationConfig.uuid);
        }

        const remainingInWorkspace = (
            (await this.integrationService.find(workspaceScope)) ?? []
        ).filter((connection) => connection.uuid !== integration.uuid);
        const workspaceKeepsAConnection = remainingInWorkspace.length > 0;

        if (
            !workspaceKeepsAConnection ||
            (await this.centralizedConfigLivesOn(
                organizationAndTeamData,
                connectionRepositoryIds,
            ))
        ) {
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
        }

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

        await this.handOverWorkspacePlan(
            organizationAndTeamData,
            remainingInWorkspace,
        );

        this.logger.log({
            message: 'connection_reset',
            context: DeleteIntegrationUseCase.name,
            metadata: {
                ...organizationAndTeamData,
                platform: integration.platform,
                remainingConnectionsInOrganization: otherConnections.length,
                actorUserId: this.request?.user?.uuid,
            },
        });
    }

    /**
     * Billing keeps the workspace plan and seats on one connection. When that
     * one leaves, the oldest remaining connection takes them. Billing being
     * down never blocks a reset: the next connection added binds again.
     */
    private async handOverWorkspacePlan(
        organizationAndTeamData: {
            organizationId: string;
            teamId: string;
            integrationId: string;
        },
        remaining: Array<{ uuid: string; createdAt?: Date }>,
    ): Promise<void> {
        if (!this.licenseService) return;
        const workspace = {
            organizationId: organizationAndTeamData.organizationId,
            teamId: organizationAndTeamData.teamId,
        };

        await this.licenseService.releaseConnection(
            workspace,
            organizationAndTeamData.integrationId,
        );

        const next = primaryConnectionOf(remaining);
        if (next) {
            await this.licenseService.bindPrimaryConnection(
                workspace,
                next.uuid,
            );
        }
    }

    /** Whether the workspace's centralized config repository is on this connection. */
    private async centralizedConfigLivesOn(
        organizationAndTeamData: { organizationId: string; teamId: string },
        connectionRepositoryIds: Set<string>,
    ): Promise<boolean> {
        const centralized = await this.parametersService?.findByKey(
            ParametersKey.CENTRALIZED_CONFIG,
            {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            },
        );
        const repositoryId = centralized?.configValue?.repository?.id;
        return (
            repositoryId != null &&
            connectionRepositoryIds.has(String(repositoryId))
        );
    }
}
