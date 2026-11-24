import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { createLogger } from '@libs/core/log/logger';
import { ConnectionAccessService } from '@libs/identity/infrastructure/adapters/services/permissions/connection-access.service';

/** Owners decide which members read each Git connection. */
@Injectable()
export class ConnectionAccessUseCase {
    private readonly logger = createLogger(ConnectionAccessUseCase.name);

    constructor(
        private readonly connectionAccessService: ConnectionAccessService,

        // HTTP-only: called from /integration/connections/:connectionId/access.
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    async list(params: {
        teamId: string;
        connectionId: string;
    }): Promise<{ userIds: string[] }> {
        await this.assertInWorkspace(params);
        return {
            userIds: await this.connectionAccessService.listGrants(
                params.connectionId,
            ),
        };
    }

    async replace(params: {
        teamId: string;
        connectionId: string;
        userIds: string[];
    }): Promise<{ userIds: string[] }> {
        const organizationId = await this.assertInWorkspace(params);

        const wanted = new Set(
            await this.connectionAccessService.membersOfOrganization(
                organizationId,
                [...new Set(params.userIds ?? [])],
            ),
        );
        const current = new Set(
            await this.connectionAccessService.listGrants(params.connectionId),
        );

        const added = [...wanted].filter((id) => !current.has(id));
        const removed = [...current].filter((id) => !wanted.has(id));

        await this.connectionAccessService.grant(params.connectionId, added);
        await this.connectionAccessService.revoke(params.connectionId, removed);

        this.logger.log({
            message: 'connection_access_changed',
            context: ConnectionAccessUseCase.name,
            metadata: {
                organizationId,
                teamId: params.teamId,
                integrationId: params.connectionId,
                granted: added,
                revoked: removed,
                actorUserId: this.request.user.uuid,
            },
        });

        return { userIds: [...wanted] };
    }

    private async assertInWorkspace(params: {
        teamId: string;
        connectionId: string;
    }): Promise<string> {
        const organizationId = this.request.user.organization.uuid;
        const found = await this.connectionAccessService.connectionInWorkspace(
            organizationId,
            params.teamId,
            params.connectionId,
        );
        if (!found) {
            throw new NotFoundException('Git connection not found.');
        }
        return organizationId;
    }
}
