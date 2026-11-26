import { Inject, Injectable } from '@nestjs/common';

import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { createLogger } from '@libs/core/log/logger';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { IntegrationEntity } from '@libs/integrations/domain/integrations/entities/integration.entity';

type Workspace = { organizationId: string; teamId: string };

/**
 * `bound`: billing keeps the workspace plan and seats on this live
 * connection. `unbound`: nothing is named and none needs to be (one
 * connection, no licence, or every connection billed on its own).
 * `failed`: billing could not be asked; nothing was changed past that step.
 */
export type PrimaryHandover =
    | { status: 'bound'; primaryConnectionId: string }
    | { status: 'unbound' }
    | { status: 'failed' };

/**
 * Which Git connection of a workspace keeps the workspace plan and seats in
 * billing, kept right as connections come and go.
 */
@Injectable()
export class ConnectionBillingService {
    private readonly logger = createLogger(ConnectionBillingService.name);

    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
    ) {}

    /** The workspace's active Git connections, oldest first. */
    async workspaceConnections(
        workspace: Workspace,
    ): Promise<IntegrationEntity[]> {
        const connections =
            (await this.integrationService.find({
                organization: { uuid: workspace.organizationId },
                team: { uuid: workspace.teamId },
                integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
                status: true,
            })) ?? [];
        return [...connections].sort((a, b) => {
            const at = a.createdAt ? new Date(a.createdAt).getTime() : Infinity;
            const bt = b.createdAt ? new Date(b.createdAt).getTime() : Infinity;
            return at - bt || a.uuid.localeCompare(b.uuid);
        });
    }

    /**
     * Before a connection is removed, billing frees the primary slot if the
     * connection holds it. False when billing could not confirm: the removal
     * must wait, or the plan would stay on a connection that no longer
     * exists.
     */
    async releaseBeforeRemoving(
        workspace: Workspace,
        connectionId: string,
    ): Promise<boolean> {
        const released = await this.licenseService.releaseConnection(
            workspace,
            connectionId,
        );
        return released !== 'failed';
    }

    /**
     * Keeps the workspace plan on a live connection: frees a primary that
     * left the workspace, then, once two connections share it (or before a
     * second is added), names the oldest connection billing accepts. A
     * connection billed on its own licence never takes the workspace plan.
     * Safe to repeat, so a pass that failed is completed by the next one.
     */
    async ensurePrimary(
        workspace: Workspace,
        options: { beforeAddingConnection?: boolean } = {},
    ): Promise<PrimaryHandover> {
        const connections = await this.workspaceConnections(workspace);
        const live = new Set(connections.map((connection) => connection.uuid));

        const licenses =
            await this.licenseService.getConnectionLicenses(workspace);
        if (!licenses) return this.failed(workspace, 'read');

        let primary = licenses.primaryConnectionId;
        if (primary && !live.has(primary)) {
            const released = await this.licenseService.releaseConnection(
                workspace,
                primary,
            );
            if (released === 'failed') return this.failed(workspace, 'release');
            this.logger.warn({
                message: 'license_primary_connection_left_released',
                context: ConnectionBillingService.name,
                metadata: { ...workspace, connectionId: primary },
            });
            primary = null;
        }
        if (primary) return { status: 'bound', primaryConnectionId: primary };

        const needsPrimary =
            connections.length >= (options.beforeAddingConnection ? 1 : 2);
        if (!needsPrimary) return { status: 'unbound' };

        const ownLicence = new Set(licenses.ownLicenceConnectionIds);
        for (const candidate of connections) {
            if (ownLicence.has(candidate.uuid)) continue;
            const answer = await this.licenseService.bindPrimaryConnection(
                workspace,
                candidate.uuid,
            );
            if (!answer.ok) return this.failed(workspace, 'bind');
            if (!answer.licensed) return { status: 'unbound' };
            if (
                answer.primaryConnectionId &&
                live.has(answer.primaryConnectionId)
            ) {
                return {
                    status: 'bound',
                    primaryConnectionId: answer.primaryConnectionId,
                };
            }
        }

        this.logger.warn({
            message: 'license_workspace_plan_unclaimed',
            context: ConnectionBillingService.name,
            metadata: {
                ...workspace,
                connectionIds: [...live],
                ownLicenceConnectionIds: licenses.ownLicenceConnectionIds,
            },
        });
        return { status: 'unbound' };
    }

    /**
     * Before the organization gets a second Git connection, seats assigned
     * before connections were recorded become its only connection's, so a
     * user of the new one with the same git id never shares them. Never
     * blocks the add: unattributed seats keep serving every connection.
     */
    async attributeLegacySeatsBeforeAdding(
        workspace: Workspace,
    ): Promise<void> {
        try {
            const organizationConnections =
                (await this.integrationService.find({
                    organization: { uuid: workspace.organizationId },
                    integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
                    status: true,
                })) ?? [];
            if (organizationConnections.length !== 1) return;
            const [only] = organizationConnections;
            await this.licenseService.attributeLegacySeats(workspace, {
                uuid: only.uuid,
                platform: only.platform,
            });
        } catch (error) {
            this.logger.error({
                message: 'license_legacy_seats_attribution_failed',
                context: ConnectionBillingService.name,
                error,
                metadata: { ...workspace },
            });
        }
    }

    private failed(
        workspace: Workspace,
        step: 'read' | 'release' | 'bind',
    ): PrimaryHandover {
        this.logger.error({
            message: 'license_primary_connection_handover_failed',
            context: ConnectionBillingService.name,
            metadata: { ...workspace, step },
        });
        return { status: 'failed' };
    }
}
