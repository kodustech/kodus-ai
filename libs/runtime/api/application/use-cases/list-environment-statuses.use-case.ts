import { Inject, Injectable } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

import type { RuntimeAuthorization } from '../run-access.service';
import { EnvironmentViewBuilder, orgOf, type RuntimeEnvironmentStatusView } from './environment-view';

/**
 * GET /runtime/environments/status — where the org's environments the caller
 * can read and their setups are, in a fixed number of reads. The screens poll
 * it while a setup runs instead of the whole list (WP1).
 */
@Injectable()
export class ListEnvironmentStatusesUseCase {
    constructor(
        private readonly reader: EnvironmentViewBuilder,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
    ) {}

    async execute(input: { user: Partial<IUser> }): Promise<RuntimeEnvironmentStatusView[]> {
        const organizationId = orgOf(input.user);
        const scope = await this.authorization.getRepositoryScope({
            user: input.user,
            action: Action.Read,
            resource: ResourceType.RuntimeEnvironment,
        });
        if (scope !== null && scope.length === 0) return [];
        return this.reader.statuses(organizationId, scope);
    }
}
