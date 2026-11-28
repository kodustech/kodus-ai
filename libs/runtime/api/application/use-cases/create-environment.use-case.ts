import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

import {
    RUNTIME_ORG_REPOSITORIES,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_SETTINGS_STORE,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RuntimeOrgRepositories,
    type RuntimeSettingsStore,
} from '../../domain/ports';
import type { RuntimeAuthorization } from '../run-access.service';
import { RuntimeEnvironmentMembers } from '../environment-members.service';
import { ensureEnvironment } from '../environment-provisioning';
import { RuntimeSetupRequester } from '../runtime-setup-requester.service';
import { orgOf, validId } from './environment-view';

/**
 * Creates the product environment of a connected repo (idempotent) and asks
 * the Runtime to set it up, through the outbox. Used by POST
 * /runtime/environments and by a repo joining the pilot.
 */
@Injectable()
export class CreateRuntimeEnvironmentUseCase {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: ProductEnvironmentStore,
        @Inject(RUNTIME_ORG_REPOSITORIES)
        private readonly repositories: RuntimeOrgRepositories,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        private readonly setups: RuntimeSetupRequester,
        // Required by Nest; a use case made without it (the older tests) writes no membership row.
        @Inject(RuntimeEnvironmentMembers)
        private readonly members?: RuntimeEnvironmentMembers,
        // Required by Nest; without it (the older tests) Set up leaves the repository's mode alone.
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings?: RuntimeSettingsStore,
    ) {}

    async execute(input: { user: Partial<IUser>; repositoryId: unknown }): Promise<ProductEnvironment> {
        const organizationId = orgOf(input.user);
        if (!validId(input.repositoryId)) throw new BadRequestException('repositoryId is required');
        const { teamId, repositories } = await this.repositories.list(organizationId);
        const repo = repositories.find((r) => r.repositoryId === input.repositoryId);
        if (!repo || !teamId) throw new NotFoundException('Repository not found');
        await this.authorization.ensure({
            user: input.user,
            action: Action.Update,
            resource: ResourceType.CodeReviewSettings,
            repoIds: [repo.repositoryId],
        });
        const { env, created } = await ensureEnvironment(
            { environments: this.environments, members: this.members, settings: this.settings },
            { organizationId, teamId, repositoryId: repo.repositoryId, repositoryName: repo.repositoryName },
        );
        // Idempotent: an existing environment is answered as it is, with no new setup.
        if (!created) return env;
        return this.setups.request(env, input.user);
    }
}
