import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { connectionDownloadScope } from '@libs/centralized-config/utils/connection-download-scope';
import { ParametersKey } from '@libs/core/domain/enums';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';

export type WorkspaceConnection = {
    integrationId: string;
    repositoryIds: string[];
};

/**
 * Which Git connection a centralized-config call is on, and what an export
 * for it holds. Each connection can have its own centralized config, so the
 * CLI, the web and the init flow scope their calls the same way.
 */
@Injectable()
export class CentralizedConfigConnectionScope {
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
    ) {}

    /** The workspace's active connections, saved repositories or not. */
    async connectionsOf(
        workspace: OrganizationAndTeamData,
    ): Promise<WorkspaceConnection[]> {
        const [connections, configs] = await Promise.all([
            this.integrationService.find({
                organization: { uuid: workspace.organizationId },
                team: { uuid: workspace.teamId },
                integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
                status: true,
            }),
            this.integrationConfigService.findAllOfTeamByConfigKey(
                IntegrationConfigKey.REPOSITORIES,
                workspace,
            ),
        ]);
        const repositoriesOf = new Map(
            (configs ?? [])
                .filter((config) => config?.integration?.uuid)
                .map((config) => [
                    config.integration.uuid,
                    (Array.isArray(config.configValue)
                        ? (config.configValue as Repositories[])
                        : []
                    ).map((repository) => String(repository.id)),
                ]),
        );
        return (connections ?? []).map((connection) => ({
            integrationId: connection.uuid,
            repositoryIds: repositoriesOf.get(connection.uuid) ?? [],
        }));
    }

    /**
     * Scopes a call to one Git connection: the one named, or the only one.
     * A workspace with several has to name it.
     */
    scopeTo(
        workspace: OrganizationAndTeamData,
        connections: WorkspaceConnection[],
        connectionId?: string,
    ): OrganizationAndTeamData {
        if (connectionId) {
            if (!connections.some((c) => c.integrationId === connectionId)) {
                throw new BadRequestException(
                    'This Git connection is not in the workspace.',
                );
            }
            return { ...workspace, integrationId: connectionId };
        }
        if (connections.length > 1) {
            throw new BadRequestException(
                `This workspace has several Git connections. Pass connectionId, one of: ${connections
                    .map((c) => c.integrationId)
                    .join(', ')}.`,
            );
        }
        return workspace;
    }

    /** The one connection that lists a repository; ambiguous or unknown answers none. */
    connectionListing(
        connections: WorkspaceConnection[],
        repositoryId: string,
    ): string | undefined {
        if (connections.length < 2) return undefined;
        const listing = connections.filter((c) =>
            c.repositoryIds.includes(String(repositoryId)),
        );
        return listing.length === 1 ? listing[0].integrationId : undefined;
    }

    /**
     * A call that names no connection (the web) is on the connection the
     * workspace's own centralized config belongs to, so its repository
     * names never resolve against another connection's repositories.
     */
    async workspaceConfigScope(
        workspace: OrganizationAndTeamData,
    ): Promise<OrganizationAndTeamData> {
        if (workspace.integrationId) return workspace;
        const connections = await this.connectionsOf(workspace);
        if (connections.length < 2) return workspace;
        const owner = (
            await this.parametersService.findByKey(
                ParametersKey.CENTRALIZED_CONFIG,
                workspace,
            )
        )?.configValue?.integrationId;
        return owner && connections.some((c) => c.integrationId === owner)
            ? { ...workspace, integrationId: owner }
            : workspace;
    }

    /**
     * With several connections, an export holds only the scoped
     * connection's repositories; a connection's own config also leaves out
     * the workspace defaults, which its sync would not apply.
     */
    async downloadScope(
        context: OrganizationAndTeamData,
        connections?: WorkspaceConnection[],
    ): Promise<{
        repositoryIds?: string[];
        includeWorkspaceDefaults?: boolean;
    }> {
        if (!context.integrationId) return {};
        const [listed, parameter] = await Promise.all([
            connections ?? this.connectionsOf(context),
            this.parametersService.findByKey(
                ParametersKey.CENTRALIZED_CONFIG,
                context,
            ),
        ]);
        return connectionDownloadScope(
            context.integrationId,
            listed.find((c) => c.integrationId === context.integrationId)
                ?.repositoryIds ?? [],
            parameter?.configValue,
        );
    }
}
