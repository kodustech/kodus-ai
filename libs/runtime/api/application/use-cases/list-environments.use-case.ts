import { Inject, Injectable } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

import type { RuntimeAuthorization } from '../run-access.service';
import { EnvironmentViewBuilder, RuntimeEnvironmentView, orgOf } from './environment-view';

/** GET /runtime/environments — the org's environments the caller can read. */
@Injectable()
export class ListRuntimeEnvironmentsUseCase {
    constructor(
        private readonly reader: EnvironmentViewBuilder,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
    ) {}

    async execute(input: { user: Partial<IUser> }): Promise<RuntimeEnvironmentView[]> {
        const organizationId = orgOf(input.user);
        const scope = await this.authorization.getRepositoryScope({
            user: input.user,
            action: Action.Read,
            resource: ResourceType.RuntimeEnvironment,
        });
        if (scope !== null && scope.length === 0) return [];
        const recent = await this.reader.recentRuns(organizationId);
        const sources = (await this.reader.sources(organizationId, recent)).filter((e) => scope === null || scope.includes(e.repositoryId));
        // The list skips the Runtime Postgres (one query per environment); the detail has egress.
        // Metrics read each environment's own Runs of the window, not a cut of the org's latest.
        return Promise.all(sources.map(async (e) => this.reader.view(e, await this.reader.environmentRuns(organizationId, e.environmentId), false)));
    }
}
