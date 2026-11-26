import {
    BadRequestException,
    Inject,
    Injectable,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { IgnoreBotsUseCase } from '@libs/organization/application/use-cases/organizationParameters/ignore-bots.use-case';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { createLogger } from '@libs/core/log/logger';
import { ConnectionBillingService } from '@libs/platform/application/services/billing/connection-billing.service';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { stateAsksForNewConnection } from '@libs/platform/infrastructure/adapters/services/github/installation-authorization';
import { ConnectionAccessService } from '@libs/identity/infrastructure/adapters/services/permissions/connection-access.service';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

@Injectable()
export class CreateIntegrationUseCase implements IUseCase {
    private readonly logger = createLogger(CreateIntegrationUseCase.name);

    constructor(
        private readonly codeManagementService: CodeManagementService,

        private readonly eventEmitter: EventEmitter2,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: {
                organization: { uuid: string };
                uuid: string;
                email: string;
            };
        },

        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        private readonly ignoreBotsUseCase: IgnoreBotsUseCase,

        private readonly telemetry: TelemetryService,

        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        private readonly connectionBilling: ConnectionBillingService,

        private readonly connectionAccess: ConnectionAccessService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Optional()
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService?: IParametersService,
    ) {}

    public async execute(params: any): Promise<any> {
        const authMode = params?.authMode ?? AuthMode.OAUTH;

        const organizationAndTeamData: {
            organizationId: string;
            teamId: string;
            integrationId?: string;
        } = {
            organizationId:
                params?.organizationAndTeamData?.organizationId ||
                this.request.user?.organization?.uuid,
            teamId: params?.organizationAndTeamData?.teamId,
        };

        // A named connection is reconnected; otherwise `newConnection` adds
        // one beside the workspace's others, and neither keeps the old
        // single-connection behaviour.
        const connectionId: string | undefined = params?.connectionId;
        if (connectionId) {
            const connection = await this.integrationService.findOne({
                uuid: connectionId,
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            });
            if (!connection) {
                throw new BadRequestException(
                    'This Git connection is not in the workspace.',
                );
            }
            organizationAndTeamData.integrationId = connectionId;
        }
        // A GitHub App link carries the request in its sealed state, tied
        // to this flow; the request's own flag serves the token paths.
        const newConnection =
            !connectionId &&
            (params?.githubState
                ? stateAsksForNewConnection(params.githubState)
                : params?.newConnection === true);
        const workspace = {
            organizationId: organizationAndTeamData.organizationId,
            teamId: organizationAndTeamData.teamId,
        };
        const connectionsBefore = connectionId
            ? undefined
            : new Set(
                  (
                      await this.connectionBilling.workspaceConnections(
                          workspace,
                      )
                  ).map((connection) => connection.uuid),
              );
        if (!connectionId) {
            await this.connectionBilling.attributeLegacySeatsBeforeAdding(
                workspace,
            );
        }
        const separateConnection = newConnection
            ? await this.bindPrimaryConnection(organizationAndTeamData)
            : false;

        const result = await this.codeManagementService.createAuthIntegration(
            {
                ...params,
                newConnection,
                organizationAndTeamData,
                authMode,
                // Who links: a GitHub App installation is linked only for the
                // user its GitHub authorization was issued to.
                userId: this.request.user?.uuid,
            },
            params.integrationType,
        );

        const integrationId: string | undefined = result?.integrationId;
        const name = typeof params?.name === 'string' ? params.name.trim() : '';
        if (integrationId && name) {
            await this.integrationService.update(
                {
                    uuid: integrationId,
                    organization: {
                        uuid: organizationAndTeamData.organizationId,
                    },
                    team: { uuid: organizationAndTeamData.teamId },
                },
                { name: name.slice(0, 120) },
            );
        }

        if (result?.success && integrationId && connectionsBefore) {
            await this.settleNewConnectionReaders(
                workspace,
                integrationId,
                connectionsBefore,
                separateConnection,
            );
        }

        if (result?.success) {
            this.logger.log({
                message: newConnection
                    ? 'connection_created'
                    : 'connection_updated',
                context: CreateIntegrationUseCase.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    integrationId,
                    platform: params.integrationType?.toUpperCase(),
                    authMode,
                    actorUserId: this.request.user?.uuid,
                },
            });
        }

        // The step before any repository exists: the setup funnel counts
        // providers here, and `repositoryConnected` counts repos later.
        void this.telemetry.gitIntegrationChanged({
            organizationId: organizationAndTeamData.organizationId,
            teamId: organizationAndTeamData.teamId,
            actorUserId: this.request.user?.uuid,
            platform: params.integrationType?.toUpperCase(),
            authMode,
            connected: true,
        });

        this.ignoreBotsUseCase
            .execute({
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                integrationId:
                    integrationId ?? organizationAndTeamData.integrationId,
                separateConnection,
            })
            .catch((error) => {
                this.logger.error({
                    message: 'Error ignoring bots',
                    error: error,
                    context: CreateIntegrationUseCase.name,
                    metadata: {
                        organizationAndTeamData: organizationAndTeamData,
                    },
                });
            });

        this.authIntegrationService
            .findOne({
                organization: {
                    uuid: organizationAndTeamData.organizationId,
                },
                team: {
                    uuid: organizationAndTeamData.teamId,
                },
            })
            .then((authIntegration) => {
                this.eventEmitter.emit(AuditLogEvents.INTEGRATION, {
                    organizationAndTeamData: {
                        organizationId: organizationAndTeamData.organizationId,
                        teamId: organizationAndTeamData.teamId,
                    },
                    userInfo: {
                        userId: this.request.user?.uuid,
                        userEmail: this.request.user?.email,
                    },
                    integration: {
                        platform:
                            params.integrationType?.toUpperCase() || 'UNKNOWN',
                        integrationCategory: 'CODE_MANAGEMENT',
                        authIntegration: authIntegration,
                    },
                    actionType: ActionType.CREATE,
                });
            })
            .catch((error) => {
                this.logger.error({
                    message: 'Error fetching auth integration for audit log',
                    error: error,
                    context: CreateIntegrationUseCase.name,
                    metadata: {
                        organizationAndTeamData: organizationAndTeamData,
                    },
                });
            });

        return result;
    }

    /**
     * The workspace's first connection is read by every member, as the
     * workspace was before connections existed. One added beside others
     * starts with owners only, and with author lists of its own.
     */
    private async settleNewConnectionReaders(
        workspace: { organizationId: string; teamId: string },
        integrationId: string,
        connectionsBefore: ReadonlySet<string>,
        separateConnection: boolean,
    ): Promise<void> {
        if (connectionsBefore.has(integrationId)) return;
        try {
            if (separateConnection) {
                await this.ignoreBotsUseCase.claimConnectionLists({
                    organizationId: workspace.organizationId,
                    integrationId,
                });
                return;
            }
            const members = await this.connectionAccess.grantWorkspaceMembers(
                workspace.teamId,
                integrationId,
            );
            this.logger.log({
                message: 'connection_granted_to_workspace_members',
                context: CreateIntegrationUseCase.name,
                metadata: {
                    ...workspace,
                    integrationId,
                    members: members.length,
                },
            });
        } catch (error) {
            this.logger.error({
                message: 'Could not settle who reads the new Git connection',
                context: CreateIntegrationUseCase.name,
                error,
                metadata: { ...workspace, integrationId, separateConnection },
            });
        }
    }

    /**
     * Before a connection is added beside others, billing records which one
     * keeps the workspace plan; otherwise the new one would share the
     * workspace's seats. Answers whether the workspace already had a
     * connection.
     */
    private async bindPrimaryConnection(organizationAndTeamData: {
        organizationId: string;
        teamId: string;
    }): Promise<boolean> {
        const workspace = {
            organizationId: organizationAndTeamData.organizationId,
            teamId: organizationAndTeamData.teamId,
        };
        const [oldest] =
            await this.connectionBilling.workspaceConnections(workspace);
        if (!oldest) return false;

        // "Review all repositories" is offered for a workspace's only
        // connection; beside another it could no longer be turned off.
        const selection =
            await this.integrationConfigService.findIntegrationConfigFormatted<{
                mode?: string;
            }>(IntegrationConfigKey.REPOSITORY_SELECTION, {
                ...workspace,
                integrationId: oldest.uuid,
            });
        if (selection?.mode === 'all') {
            throw new BadRequestException(
                'Turn off reviewing all repositories in Settings > Git before adding another Git connection.',
            );
        }
        await this.recordCentralizedConfigOwner(workspace, oldest.uuid);

        const handover = await this.connectionBilling.ensurePrimary(workspace, {
            beforeAddingConnection: true,
        });
        if (handover.status === 'failed') {
            throw new ServiceUnavailableException(
                'Billing could not be reached to add this connection. Try again in a moment.',
            );
        }
        return true;
    }

    /**
     * A centralized config stored before the workspace had several Git
     * connections serves every connection. Recorded on the existing one
     * before another is added, so it keeps applying only to its repositories.
     */
    private async recordCentralizedConfigOwner(
        organizationAndTeamData: { organizationId: string; teamId: string },
        integrationId: string,
    ): Promise<void> {
        if (!this.parametersService) return;
        const parameter = await this.parametersService.findByKey(
            ParametersKey.CENTRALIZED_CONFIG,
            organizationAndTeamData,
        );
        const configValue = parameter?.configValue;
        // A config never set up, or cleared, belongs to no connection.
        if (!configValue?.repository?.id || configValue.integrationId) return;
        await this.parametersService.createOrUpdateConfig(
            ParametersKey.CENTRALIZED_CONFIG,
            configValue,
            { ...organizationAndTeamData, integrationId },
        );
        this.logger.log({
            message: 'centralized_config_owner_recorded',
            context: CreateIntegrationUseCase.name,
            metadata: { ...organizationAndTeamData, integrationId },
        });
    }
}
