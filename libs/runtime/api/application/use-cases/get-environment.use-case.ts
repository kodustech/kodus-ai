import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

import type { RuntimeAuthorization } from '../run-access.service';
import { EnvironmentViewBuilder, RuntimeEnvironmentView, orgOf } from './environment-view';

/** GET /runtime/environments/:id — another org's environment is 404. */
@Injectable()
export class GetRuntimeEnvironmentUseCase {
    constructor(
        private readonly reader: EnvironmentViewBuilder,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
    ) {}

    async load(user: Partial<IUser>, environmentId: string) {
        const organizationId = orgOf(user);
        const found = await this.reader.source(organizationId, environmentId);
        if (!found) throw new NotFoundException('Environment not found');
        // Its machines hold the code of every repository of the environment: reading it needs all of them.
        await this.authorization.ensure({ user, action: Action.Read, resource: ResourceType.RuntimeEnvironment, repoIds: await this.reader.repositoryIdsOf(found.env) });
        return found;
    }

    /** Every repository of the environment: acting on it needs access to all of them. */
    repositoryIdsOf(env: { organizationId: string; environmentId: string; repositoryId: string }) {
        return this.reader.repositoryIdsOf(env);
    }

    async setup(env: { environmentId: string; organizationId: string }) {
        return this.reader.setup(env.organizationId, env.environmentId);
    }

    async execute(input: { user: Partial<IUser>; environmentId: string }): Promise<RuntimeEnvironmentView> {
        const { env, runs } = await this.load(input.user, input.environmentId);
        return this.reader.view(env, runs, true);
    }
}
