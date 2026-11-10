import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

import { RUNTIME_PRODUCT_ENVIRONMENT_STORE, type ProductEnvironment, type ProductEnvironmentStore } from '../../domain/ports';
import type { RuntimeAuthorization } from '../run-access.service';
import { RuntimeSetupRequester } from '../runtime-setup-requester.service';
import { orgOf, validId } from './environment-view';

/** POST /runtime/environments/:id/setup — (re)build the environment from its recipe on the default branch. */
@Injectable()
export class RequestEnvironmentSetupUseCase {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: ProductEnvironmentStore,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        private readonly setups: RuntimeSetupRequester,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string }): Promise<ProductEnvironment> {
        const organizationId = orgOf(input.user);
        const env = validId(input.environmentId) ? await this.environments.get(organizationId, input.environmentId) : null;
        if (!env || env.organizationId !== organizationId) throw new NotFoundException('Environment not found');
        await this.authorization.ensure({
            user: input.user,
            action: Action.Update,
            resource: ResourceType.CodeReviewSettings,
            repoIds: [env.repositoryId],
        });
        return this.setups.request(env, input.user);
    }
}
