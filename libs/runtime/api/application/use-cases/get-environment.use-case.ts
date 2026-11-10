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
        await this.authorization.ensure({ user, action: Action.Read, resource: ResourceType.RuntimeEnvironment, repoIds: [found.env.repositoryId] });
        return found;
    }

    async setup(env: { environmentId: string; organizationId: string }) {
        return this.reader.setup(env.organizationId, env.environmentId);
    }

    async execute(input: { user: Partial<IUser>; environmentId: string }): Promise<RuntimeEnvironmentView> {
        const { env, runs } = await this.load(input.user, input.environmentId);
        return this.reader.view(env, runs, true);
    }
}
