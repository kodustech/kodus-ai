import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { MAX_WORKSPACE_REPOSITORIES, REPOSITORY_ALIAS_PATTERN, RepositoryFullNameSchema } from '@libs/runtime/contracts/workspace';

import {
    EnvironmentRepositoryConflictError,
    RUNTIME_ENVIRONMENT_REPOSITORY_STORE,
    RUNTIME_ORG_REPOSITORIES,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    type EnvironmentRepository,
    type EnvironmentRepositoryPatch,
    type EnvironmentRepositoryStore,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RuntimeOrgRepositories,
} from '../../domain/ports';
import { defaultAliasOf, primaryAliasOf, RuntimeEnvironmentMembers } from '../environment-members.service';
import type { RuntimeAuthorization } from '../run-access.service';
import { RuntimeSetupRequester } from '../runtime-setup-requester.service';
import type { RuntimeEnvironmentRepositoryView } from './environment-view';
import { orgOf, validId } from './environment-view';

/** What a write on an environment's repositories answers: the repositories as they are now, and the setup it asked for. */
export interface EnvironmentRepositoriesResult {
    repositories: RuntimeEnvironmentRepositoryView[];
    /** The repository the call added or changed; absent for a removal. */
    repository?: RuntimeEnvironmentRepositoryView;
    /** A setup was asked for: the environment boots with the new set of repositories once it passes. */
    setupRequested: boolean;
    setupRequestedAt?: string;
}

const view = (r: EnvironmentRepository): RuntimeEnvironmentRepositoryView => ({
    repositoryId: r.repositoryId,
    repositoryName: r.repositoryName,
    fullName: r.fullName,
    alias: r.alias,
    role: r.role,
    triggers: r.triggers,
    pairBranches: r.pairBranches,
});

const conflict = (e: unknown): never => {
    if (e instanceof EnvironmentRepositoryConflictError) {
        throw new ConflictException(e.conflict === 'alias' ? 'Another repository of this environment has that alias' : e.message);
    }
    throw e;
};

const optionalBoolean = (v: unknown, name: string): boolean | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') throw new BadRequestException(`${name} must be true or false`);
    return v;
};

const aliasOf = (v: unknown): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !REPOSITORY_ALIAS_PATTERN.test(v)) {
        throw new BadRequestException("alias must be lower case letters, digits, '.', '_' or '-', starting with a letter or digit, at most 63 characters");
    }
    return v;
};

/**
 * The repositories of an environment (docs/plans/2026-11-11-runtime-multi-repo-environments.md):
 * GET /runtime/environments/:id/repositories, POST (add), PATCH
 * :repositoryId (triggers, pair branches, alias), DELETE :repositoryId
 * (members only; the primary leaves with its environment). Org-scoped: another
 * org's environment is 404. Every write needs Manage on the environment over
 * every repository it will hold, since its machines hold all their code; a
 * change of the set (or of a directory) asks for a setup, and Runs keep the
 * last good setup until it passes.
 */
@Injectable()
export class EnvironmentRepositoriesUseCase {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(RUNTIME_ENVIRONMENT_REPOSITORY_STORE)
        private readonly store: EnvironmentRepositoryStore,
        @Inject(RUNTIME_ORG_REPOSITORIES)
        private readonly orgRepositories: RuntimeOrgRepositories,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        @Inject(RuntimeEnvironmentMembers)
        private readonly members: RuntimeEnvironmentMembers,
        private readonly setups: RuntimeSetupRequester,
    ) {}

    async list(input: { user: Partial<IUser>; environmentId: string }): Promise<RuntimeEnvironmentRepositoryView[]> {
        const { members } = await this.load(input.user, input.environmentId);
        return members.map(view);
    }

    async add(input: { user: Partial<IUser>; environmentId: string; body: unknown }): Promise<EnvironmentRepositoriesResult> {
        const body = (input.body ?? {}) as { repositoryId?: unknown; alias?: unknown; triggers?: unknown; pairBranches?: unknown };
        if (!validId(body.repositoryId)) throw new BadRequestException('repositoryId is required');
        const alias = aliasOf(body.alias);
        const triggers = optionalBoolean(body.triggers, 'triggers');
        const pairBranches = optionalBoolean(body.pairBranches, 'pairBranches');
        const { env, members } = await this.load(input.user, input.environmentId);
        const { repositories } = await this.orgRepositories.list(env.organizationId);
        const repo = repositories.find((r) => r.repositoryId === body.repositoryId);
        if (!repo) throw new NotFoundException('Repository not found; connect it to Kodus first');
        // Adding a repository gives the environment's machines its code: the caller needs it too.
        await this.ensure(input.user, [...members.map((m) => m.repositoryId), repo.repositoryId]);

        const existing = members.find((m) => m.repositoryId === repo.repositoryId);
        if (existing) {
            if (existing.role === 'primary') throw new ConflictException("The repository is this environment's primary");
            // Idempotent: the same repository added again is the row as it is.
            return { repositories: members.map(view), repository: view(existing), setupRequested: false };
        }
        if (members.length >= MAX_WORKSPACE_REPOSITORIES) {
            throw new ConflictException(`An environment holds at most ${MAX_WORKSPACE_REPOSITORIES} repositories`);
        }
        if (!RepositoryFullNameSchema.safeParse(repo.repositoryName).success) {
            throw new ConflictException(`Kodus does not know ${repo.repositoryName} as owner/name, which the environment boots it by`);
        }
        const memberAlias = alias ?? defaultAliasOf(repo.repositoryName);
        this.refusePrimaryAlias(env, memberAlias, alias === undefined);
        // The primary's row first, so the environment never reads as members without it.
        await this.members.ensurePrimary(env);
        const added = await this.store
            .add({
                environmentId: env.environmentId,
                organizationId: env.organizationId,
                repositoryId: repo.repositoryId,
                repositoryName: repo.repositoryName,
                fullName: repo.repositoryName,
                role: 'member',
                alias: memberAlias,
                triggers: triggers ?? true,
                pairBranches: pairBranches ?? false,
            })
            .catch(conflict);
        if (!added) throw new NotFoundException('Environment not found');
        return this.withSetup(env, input.user, added);
    }

    async update(input: { user: Partial<IUser>; environmentId: string; repositoryId: string; body: unknown }): Promise<EnvironmentRepositoriesResult> {
        const body = (input.body ?? {}) as { alias?: unknown; triggers?: unknown; pairBranches?: unknown };
        const unknown = Object.keys(body).filter((k) => !['alias', 'triggers', 'pairBranches'].includes(k));
        if (unknown.length) throw new BadRequestException(`Unknown fields: ${unknown.join(', ')}`);
        const patch: EnvironmentRepositoryPatch = {
            ...(body.alias !== undefined ? { alias: aliasOf(body.alias) } : {}),
            ...(body.triggers !== undefined ? { triggers: optionalBoolean(body.triggers, 'triggers') } : {}),
            ...(body.pairBranches !== undefined ? { pairBranches: optionalBoolean(body.pairBranches, 'pairBranches') } : {}),
        };
        if (!Object.keys(patch).length) throw new BadRequestException('Send alias, triggers or pairBranches');
        const { env, members } = await this.load(input.user, input.environmentId);
        await this.ensure(input.user, members.map((m) => m.repositoryId));
        const current = members.find((m) => m.repositoryId === input.repositoryId);
        if (!current) throw new NotFoundException('The repository is not part of this environment');
        if (current.role === 'primary') {
            // The cell derives the primary's directory from its full name; the protocol has no field to move it.
            if (patch.alias !== undefined && patch.alias !== current.alias) {
                throw new ConflictException(`The primary repository's alias is fixed (${current.alias}): it is derived from its name`);
            }
            delete patch.alias;
            if (!Object.keys(patch).length) return { repositories: members.map(view), repository: view(current), setupRequested: false };
            await this.members.ensurePrimary(env);
        } else if (patch.alias !== undefined) {
            this.refusePrimaryAlias(env, patch.alias, false);
        }
        const updated = await this.store.update(env.organizationId, env.environmentId, current.repositoryId, patch).catch(conflict);
        if (!updated) throw new NotFoundException('The repository is not part of this environment');
        // A new directory moves the repository in the workspace: what the setup built no longer matches it.
        if (patch.alias !== undefined && patch.alias !== current.alias) return this.withSetup(env, input.user, updated);
        return { repositories: (await this.members.list(env)).map(view), repository: view(updated), setupRequested: false };
    }

    async remove(input: { user: Partial<IUser>; environmentId: string; repositoryId: string }): Promise<EnvironmentRepositoriesResult> {
        const { env, members } = await this.load(input.user, input.environmentId);
        await this.ensure(input.user, members.map((m) => m.repositoryId));
        const current = members.find((m) => m.repositoryId === input.repositoryId);
        if (!current) throw new NotFoundException('The repository is not part of this environment');
        if (current.role === 'primary') throw new ConflictException('The primary repository leaves only with its environment');
        if (!(await this.store.remove(env.organizationId, env.environmentId, current.repositoryId))) {
            throw new NotFoundException('The repository is not part of this environment');
        }
        return this.withSetup(env, input.user);
    }

    /** The org's environment and its repositories, after the read check over every one of them. */
    private async load(user: Partial<IUser>, environmentId: string): Promise<{ env: ProductEnvironment; members: EnvironmentRepository[] }> {
        const organizationId = orgOf(user);
        const env = validId(environmentId) ? await this.environments.get(organizationId, environmentId) : null;
        if (!env || env.organizationId !== organizationId) throw new NotFoundException('Environment not found');
        const members = await this.members.list(env);
        await this.authorization.ensure({ user, action: Action.Read, resource: ResourceType.RuntimeEnvironment, repoIds: members.map((m) => m.repositoryId) });
        return { env, members };
    }

    /** A member never takes the primary's directory (ws/<primary alias>). */
    private refusePrimaryAlias(env: ProductEnvironment, alias: string, defaulted: boolean) {
        if (alias !== primaryAliasOf(env)) return;
        throw new ConflictException(
            defaulted
                ? `The repository's default alias (${alias}) is the primary's; give it another alias`
                : `The alias ${alias} is the primary repository's; give the repository another one`,
        );
    }

    private ensure(user: Partial<IUser>, repoIds: string[]) {
        return this.authorization.ensure({ user, action: Action.Manage, resource: ResourceType.RuntimeEnvironment, repoIds: [...new Set(repoIds)] });
    }

    private async withSetup(env: ProductEnvironment, user: Partial<IUser>, changed?: EnvironmentRepository): Promise<EnvironmentRepositoriesResult> {
        const requested = await this.setups.request(env, user);
        return {
            repositories: (await this.members.list(env)).map(view),
            ...(changed ? { repository: view(changed) } : {}),
            setupRequested: true,
            ...(requested.setupRequestedAt ? { setupRequestedAt: requested.setupRequestedAt } : {}),
        };
    }
}
