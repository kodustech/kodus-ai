import {
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { createLogger } from '@libs/core/log/logger';
import { ConnectionAccessService } from '@libs/identity/infrastructure/adapters/services/permissions/connection-access.service';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';

type Caller = {
    uuid?: string;
    role?: string;
    organization?: { uuid?: string };
};

/**
 * Sets the PR author lists of one Git connection, or the organization's when
 * none is named. Only those lists are written, merged into the stored value
 * in one statement, so the bots seeded meanwhile, the revocation timers and
 * the other connections' lists stay.
 */
@Injectable()
export class UpdateAuthorFiltersUseCase {
    private readonly logger = createLogger(UpdateAuthorFiltersUseCase.name);

    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        private readonly connectionAccess: ConnectionAccessService,
    ) {}

    async execute(params: {
        user: Caller;
        connectionId?: string;
        ignoredUsers: string[];
        allowedUsers: string[];
    }): Promise<void> {
        const organizationId = params.user?.organization?.uuid;
        if (!organizationId) {
            throw new ForbiddenException('Organization ID is missing');
        }
        const { connectionId } = params;

        const restriction = await this.connectionAccess.restrictionFor(
            params.user,
        );
        if (
            restriction &&
            (!connectionId || !restriction.connectionIds.has(connectionId))
        ) {
            throw new ForbiddenException(
                'You are not granted this Git connection of the workspace.',
            );
        }
        if (
            connectionId &&
            !(await this.connectionAccess.connectionInOrganization(
                organizationId,
                connectionId,
            ))
        ) {
            throw new NotFoundException('Git connection not found.');
        }

        await this.organizationParametersService.mergeConfigValue(
            OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
            organizationId,
            {
                ignoredUsers: params.ignoredUsers.map(String),
                allowedUsers: params.allowedUsers.map(String),
            },
            connectionId ? { connectionId } : {},
        );

        this.logger.log({
            message: 'pr_author_filters_updated',
            context: UpdateAuthorFiltersUseCase.name,
            metadata: {
                organizationId,
                connectionId: connectionId ?? null,
                ignored: params.ignoredUsers.length,
                allowed: params.allowedUsers.length,
                actorUserId: params.user?.uuid,
            },
        });
    }
}
