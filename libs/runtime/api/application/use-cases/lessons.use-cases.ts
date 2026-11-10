import { randomUUID } from 'crypto';

import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';

import { IOutboxMessageRepository, OUTBOX_MESSAGE_REPOSITORY_TOKEN } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import type { Lesson } from '@libs/runtime/blockers/lessons';

import { type Clock, RUNTIME_CLOCK, RUNTIME_LESSON_READER, type RuntimeLessonReader } from '../../domain/ports';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '../../domain/runtime-commands';
import type { RuntimeAuthorization } from '../run-access.service';
import { GetRuntimeEnvironmentUseCase } from './environments.use-cases';

/** A lesson as the product shows it: problem, cause, the fix that worked and where it was proven. */
export type RuntimeLessonView = Pick<
    Lesson,
    'lessonId' | 'scope' | 'signature' | 'kind' | 'problem' | 'cause' | 'fix' | 'helped' | 'firstAt' | 'lastAt' | 'promotedAt'
> & {
    origin: { sha: string; branch?: string; at: string; repositoryId: string };
};

const view = (l: Lesson): RuntimeLessonView => ({
    lessonId: l.lessonId,
    scope: l.scope,
    signature: l.signature,
    kind: l.kind,
    problem: l.problem,
    cause: l.cause,
    fix: l.fix,
    helped: l.helped,
    firstAt: l.firstAt,
    lastAt: l.lastAt,
    ...(l.promotedAt ? { promotedAt: l.promotedAt } : {}),
    origin: { sha: l.origin.sha, ...(l.origin.branch ? { branch: l.origin.branch } : {}), at: l.origin.at, repositoryId: l.repositoryId },
});

/**
 * GET /runtime/environments/:id/lessons — what Kody learned that applies to
 * this environment's repo: its own lessons and the org's (ADR-018). Readers
 * of the environment see them; nothing from another org.
 */
@Injectable()
export class ListEnvironmentLessonsUseCase {
    constructor(
        private readonly environment: GetRuntimeEnvironmentUseCase,
        @Optional() @Inject(RUNTIME_LESSON_READER) private readonly lessons?: RuntimeLessonReader,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string }): Promise<RuntimeLessonView[]> {
        const { env } = await this.environment.load(input.user, input.environmentId);
        const all = this.lessons ? await this.lessons.listByOrganization(env.organizationId) : [];
        return all
            .filter((l) => l.organizationId === env.organizationId && l.state === 'active' && (l.scope === 'org' || l.repositoryId === env.repositoryId))
            .map(view);
    }
}

/**
 * POST /runtime/environments/:id/lessons/:lessonId/{promote,retire} — the org
 * admin's say over memory (ADR-018: a repo lesson reaches the other repos of
 * the org only when an admin promotes it). Sent to the worker, which owns the
 * store, through the outbox; the lesson must be one this environment sees.
 */
@Injectable()
export class UpdateEnvironmentLessonUseCase {
    constructor(
        private readonly list: ListEnvironmentLessonsUseCase,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: Pick<IOutboxMessageRepository, 'create'>,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string; lessonId: string; action: 'promote' | 'retire' }) {
        const lesson = (await this.list.execute(input)).find((l) => l.lessonId === input.lessonId);
        if (!lesson) throw new NotFoundException('Lesson not found');
        await this.authorization.ensure({ user: input.user, action: Action.Manage, resource: ResourceType.RuntimeEnvironment });
        const organizationId = input.user.organization!.uuid!;
        const requestedAt = this.now().toISOString();
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.LessonUpdateRequested,
                {
                    lessonId: lesson.lessonId,
                    organizationId,
                    action: input.action,
                    requestedBy: { userId: input.user.uuid!, ...(input.user.email ? { email: input.user.email } : {}) },
                    requestedAt,
                },
                randomUUID(),
            ),
        );
        return { lessonId: lesson.lessonId, action: input.action, requestedAt };
    }
}
