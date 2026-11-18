import { Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { RUNTIME_LESSON_READER, RUNTIME_ORG_REPOSITORIES, type RuntimeLessonReader, type RuntimeOrgRepositories } from '../../domain/ports';
import { RuntimeEnvironmentMembers } from '../environment-members.service';
import { blockerGroups, memoryFor, membershipBlockerGroups } from './environment-blockers';
import { RuntimeBlockerGroupView, type RuntimeMembershipBlockerGroupView } from './environment-view';
import { GetRuntimeEnvironmentUseCase } from './get-environment.use-case';

/** GET /runtime/environments/:id/blockers — the groups, with their evidence and fixes, what worked before first. */
@Injectable()
export class ListEnvironmentBlockersUseCase {
    constructor(
        private readonly environment: GetRuntimeEnvironmentUseCase,
        @Optional() @Inject(RUNTIME_LESSON_READER) private readonly lessons?: RuntimeLessonReader,
        // Required by Nest; made without them (the older tests), services.needs is not checked against membership.
        @Inject(RuntimeEnvironmentMembers) private readonly members?: RuntimeEnvironmentMembers,
        @Inject(RUNTIME_ORG_REPOSITORIES) private readonly orgRepositories?: RuntimeOrgRepositories,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string }): Promise<Array<RuntimeBlockerGroupView | RuntimeMembershipBlockerGroupView>> {
        const { env, runs } = await this.environment.load(input.user, input.environmentId);
        const setup = await this.environment.setup(env);
        const groups: RuntimeBlockerGroupView[] = blockerGroups(setup, runs, await memoryFor(this.lessons, env)).map(({ recipeChanges: _, ...view }) => view);
        return [...(await this.membership(env, setup)), ...groups];
    }

    /** The repositories the committed recipe needs that the environment does not hold (environment-blockers.ts). */
    private async membership(env: { environmentId: string; organizationId: string; repositoryId: string; repositoryName?: string }, setup: Parameters<typeof membershipBlockerGroups>[0]) {
        if (!this.members || !this.orgRepositories || !env.repositoryName || !setup) return [];
        const members = await this.members.list({ ...env, repositoryName: env.repositoryName });
        // Unreadable is not "none connected": an empty list would tell the user to connect a repository that is connected.
        const { repositories } = await this.orgRepositories.list(env.organizationId).catch(() => {
            throw new ServiceUnavailableException('The repositories connected to Kodus could not be read. Try again.');
        });
        return membershipBlockerGroups(setup, members, repositories);
    }
}
