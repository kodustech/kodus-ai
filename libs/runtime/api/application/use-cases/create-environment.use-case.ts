import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

import {
    RUNTIME_ORG_REPOSITORIES,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RuntimeOrgRepositories,
} from '../../domain/ports';
import type { RuntimeAuthorization } from '../run-access.service';
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
        const existing = await this.environments.findByRepository(organizationId, repo.repositoryId);
        if (existing) return existing;
        const env = await this.environments.create({ organizationId, teamId, repositoryId: repo.repositoryId, repositoryName: repo.repositoryName });
        return this.setups.request(env, input.user);
    }
}
