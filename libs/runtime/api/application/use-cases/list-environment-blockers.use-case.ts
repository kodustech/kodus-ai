import { Inject, Injectable, Optional } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { RUNTIME_LESSON_READER, type RuntimeLessonReader } from '../../domain/ports';
import { blockerGroups, memoryFor } from './environment-blockers';
import { RuntimeBlockerGroupView } from './environment-view';
import { GetRuntimeEnvironmentUseCase } from './get-environment.use-case';

/** GET /runtime/environments/:id/blockers — the groups, with their evidence and fixes, what worked before first. */
@Injectable()
export class ListEnvironmentBlockersUseCase {
    constructor(
        private readonly environment: GetRuntimeEnvironmentUseCase,
        @Optional() @Inject(RUNTIME_LESSON_READER) private readonly lessons?: RuntimeLessonReader,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string }): Promise<RuntimeBlockerGroupView[]> {
        const { env, runs } = await this.environment.load(input.user, input.environmentId);
        const setup = await this.environment.setup(env);
        return blockerGroups(setup, runs, await memoryFor(this.lessons, env)).map(({ recipeChanges: _, ...view }) => view);
    }
}
