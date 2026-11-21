import { Inject, Injectable } from '@nestjs/common';

import { repositoryAliasOf } from '@libs/runtime/contracts/workspace';

import {
    EnvironmentRepositoryConflictError,
    RUNTIME_ENVIRONMENT_REPOSITORY_STORE,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    type EnvironmentRepository,
    type EnvironmentRepositoryStore,
    type ProductEnvironment,
    type ProductEnvironmentStore,
} from '../domain/ports';

/** The fields of an environment its repositories are read by. */
export type EnvironmentKey = Pick<ProductEnvironment, 'environmentId' | 'organizationId' | 'repositoryId' | 'repositoryName'>;

/** An environment a repository is part of, with that repository's place in it. */
export interface EnvironmentMembership {
    env: ProductEnvironment;
    member: EnvironmentRepository;
}

/** The alias a repository gets when it names none: its short name, or `repo` (the membership backfill's rule). */
export const defaultAliasOf = (repositoryName: string) => repositoryAliasOf(repositoryName);

/**
 * The primary's alias, fixed: repositoryAliasOf of its full name, which the
 * cell derives the same way (the protocol carries no alias for it), with the
 * backfill's `repo` when nothing is left. It never changes.
 */
export const primaryAliasOf = (env: Pick<ProductEnvironment, 'repositoryName'>) => defaultAliasOf(env.repositoryName);

/**
 * The primary row an environment has by definition: its own repository. What
 * the store holds for it once create() or the backfill wrote it, and what a
 * read stands in with when the row is not there.
 */
export function primaryOf(env: EnvironmentKey & { createdAt?: string; updatedAt?: string }): EnvironmentRepository {
    const at = env.createdAt ?? new Date(0).toISOString();
    return {
        environmentId: env.environmentId,
        organizationId: env.organizationId,
        repositoryId: env.repositoryId,
        repositoryName: env.repositoryName,
        fullName: env.repositoryName,
        role: 'primary',
        alias: primaryAliasOf(env),
        triggers: true,
        pairBranches: false,
        createdAt: at,
        updatedAt: env.updatedAt ?? at,
    };
}

/** The membership store of a deployment without one (and of the tests that predate it): every environment is its primary alone. */
export const NO_MEMBERSHIP: Pick<EnvironmentRepositoryStore, 'listByEnvironment' | 'listByRepository'> = {
    listByEnvironment: async () => [],
    listByRepository: async () => [],
};

/**
 * Every lookup of an environment by repository, and of an environment's
 * repositories, in one place: through `runtime_environment_repositories`.
 * An environment with no rows (one written before the table, or between its
 * create and its primary row) reads as its primary alone, so a
 * single-repository environment behaves as it did before membership.
 */
@Injectable()
export class RuntimeEnvironmentMembers {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: Pick<ProductEnvironmentStore, 'findByRepository'> &
            Partial<Pick<ProductEnvironmentStore, 'get' | 'getMany' | 'findByRepositories'>>,
        @Inject(RUNTIME_ENVIRONMENT_REPOSITORY_STORE)
        private readonly repositories: Pick<EnvironmentRepositoryStore, 'listByEnvironment' | 'listByRepository'> &
            Partial<Pick<EnvironmentRepositoryStore, 'add' | 'listByEnvironments' | 'listByRepositories'>> = NO_MEMBERSHIP,
    ) {}

    /** A reader with no membership table: what a use case built without one falls back to. */
    static primaryOnly(environments: Pick<ProductEnvironmentStore, 'findByRepository'> & Partial<Pick<ProductEnvironmentStore, 'get' | 'getMany' | 'findByRepositories'>>) {
        return new RuntimeEnvironmentMembers(environments, NO_MEMBERSHIP);
    }

    /** The environment's repositories, the primary first, then by alias. Never empty. */
    async list(env: EnvironmentKey & { createdAt?: string; updatedAt?: string }): Promise<EnvironmentRepository[]> {
        return membersOf(env, await this.repositories.listByEnvironment(env.organizationId, env.environmentId));
    }

    /** The ids of every repository of the environment, the primary first. */
    async repositoryIds(env: EnvironmentKey): Promise<string[]> {
        return (await this.list(env)).map((r) => r.repositoryId);
    }

    /** The membership rows of these environments of one org: one read when the store has the batch read. */
    private async rowsOfEnvironments(organizationId: string, environmentIds: readonly string[]): Promise<EnvironmentRepository[]> {
        const ids = [...new Set(environmentIds)];
        if (!ids.length) return [];
        if (this.repositories.listByEnvironments) return this.repositories.listByEnvironments(organizationId, ids);
        return (await Promise.all(ids.map((id) => this.repositories.listByEnvironment(organizationId, id)))).flat();
    }

    /** repositoryIds() of several environments of one org, in one read of the membership table: by environment id. */
    async repositoryIdsOfMany(envs: readonly EnvironmentKey[]): Promise<Map<string, string[]>> {
        const out = new Map<string, string[]>();
        for (const [organizationId, list] of byOrganization(envs)) {
            const rows = await this.rowsOfEnvironments(
                organizationId,
                list.map((e) => e.environmentId),
            );
            for (const env of list) out.set(env.environmentId, membersOf(env, rows).map((r) => r.repositoryId));
        }
        return out;
    }

    /** repositoryIdsOfEnvironment() of several environments of one org, in one read: by environment id. */
    async repositoryIdsOfEnvironments(organizationId: string, known: ReadonlyMap<string, readonly string[]>): Promise<Map<string, string[]>> {
        const rows = await this.rowsOfEnvironments(organizationId, [...known.keys()]);
        return new Map(
            [...known].map(([environmentId, ids]) => [
                environmentId,
                [...new Set([...ids, ...rows.filter((r) => r.organizationId === organizationId && r.environmentId === environmentId).map((r) => r.repositoryId)])],
            ]),
        );
    }

    /**
     * The repositories of an environment known by id only (a Run names its
     * environment and its own repository): every member row, and `known`,
     * which the Run itself names.
     */
    async repositoryIdsOfEnvironment(organizationId: string, environmentId: string, known: readonly string[]): Promise<string[]> {
        const rows = await this.repositories.listByEnvironment(organizationId, environmentId);
        const ids = rows.filter((r) => r.organizationId === organizationId && r.environmentId === environmentId).map((r) => r.repositoryId);
        return [...new Set([...known, ...ids])];
    }

    /**
     * Every environment the repository is part of, as its primary or a
     * member, the one it is the primary of first. Only the org's.
     */
    async environmentsOf(organizationId: string, repositoryId: string): Promise<EnvironmentMembership[]> {
        const rows = (await this.repositories.listByRepository(organizationId, repositoryId)).filter(
            (r) => r.organizationId === organizationId && r.repositoryId === repositoryId,
        );
        const out: EnvironmentMembership[] = [];
        const seen = new Set<string>();
        for (const member of rows) {
            if (seen.has(member.environmentId)) continue;
            const env = this.environments.get ? await this.environments.get(organizationId, member.environmentId) : null;
            if (!env || env.organizationId !== organizationId) continue;
            seen.add(env.environmentId);
            // The row of the environment's own repository is its primary, whatever it says.
            out.push({ env, member: env.repositoryId === repositoryId ? { ...member, role: 'primary' } : { ...member, role: 'member' } });
        }
        const own = await this.environments.findByRepository(organizationId, repositoryId);
        if (own && own.organizationId === organizationId && !seen.has(own.environmentId)) out.push({ env: own, member: primaryOf(own) });
        return out.sort((a, b) => (a.member.role === b.member.role ? 0 : a.member.role === 'primary' ? -1 : 1));
    }

    /**
     * environmentsOf() of several repositories of one org, in a constant
     * number of reads (membership rows, their environments, the environments
     * the repositories are the primary of): by repository id.
     */
    async environmentsOfMany(organizationId: string, repositoryIds: readonly string[]): Promise<Map<string, EnvironmentMembership[]>> {
        const ids = [...new Set(repositoryIds)];
        const out = new Map<string, EnvironmentMembership[]>(ids.map((id) => [id, []]));
        if (!ids.length) return out;
        const wanted = new Set(ids);
        const rows = (
            this.repositories.listByRepositories
                ? await this.repositories.listByRepositories(organizationId, ids)
                : (await Promise.all(ids.map((id) => this.repositories.listByRepository(organizationId, id)))).flat()
        ).filter((r) => r.organizationId === organizationId && wanted.has(r.repositoryId));
        const environmentIds = [...new Set(rows.map((r) => r.environmentId))];
        const [envs, owns] = await Promise.all([this.getEnvironments(organizationId, environmentIds), this.ownEnvironments(organizationId, ids)]);
        const byId = new Map(envs.filter((e) => e.organizationId === organizationId).map((e) => [e.environmentId, e]));
        for (const repositoryId of ids) {
            const found = out.get(repositoryId)!;
            const seen = new Set<string>();
            for (const member of rows) {
                if (member.repositoryId !== repositoryId || seen.has(member.environmentId)) continue;
                const env = byId.get(member.environmentId);
                if (!env) continue;
                seen.add(env.environmentId);
                found.push({ env, member: env.repositoryId === repositoryId ? { ...member, role: 'primary' } : { ...member, role: 'member' } });
            }
            const own = owns.get(repositoryId);
            if (own && own.organizationId === organizationId && !seen.has(own.environmentId)) found.push({ env: own, member: primaryOf(own) });
            found.sort((a, b) => (a.member.role === b.member.role ? 0 : a.member.role === 'primary' ? -1 : 1));
        }
        return out;
    }

    private async getEnvironments(organizationId: string, environmentIds: string[]): Promise<ProductEnvironment[]> {
        if (!environmentIds.length) return [];
        if (this.environments.getMany) return this.environments.getMany(organizationId, environmentIds);
        const get = this.environments.get;
        if (!get) return [];
        return (await Promise.all(environmentIds.map((id) => get.call(this.environments, organizationId, id)))).filter((e): e is ProductEnvironment => !!e);
    }

    private async ownEnvironments(organizationId: string, repositoryIds: string[]): Promise<Map<string, ProductEnvironment>> {
        const list = this.environments.findByRepositories
            ? await this.environments.findByRepositories(organizationId, repositoryIds)
            : (await Promise.all(repositoryIds.map((id) => this.environments.findByRepository(organizationId, id)))).filter((e): e is ProductEnvironment => !!e);
        const out = new Map<string, ProductEnvironment>();
        for (const e of list) if (!out.has(e.repositoryId)) out.set(e.repositoryId, e);
        return out;
    }

    /** The environments a pull request of the repository starts a Run of: the memberships with `triggers`. */
    async triggeredBy(organizationId: string, repositoryId: string): Promise<EnvironmentMembership[]> {
        return (await this.environmentsOf(organizationId, repositoryId)).filter((m) => m.member.triggers);
    }

    /** Writes the environment's primary row (idempotent): what create() owes every new environment. */
    async ensurePrimary(env: EnvironmentKey): Promise<void> {
        if (!this.repositories.add) return;
        const primary = primaryOf(env);
        const { createdAt: _c, updatedAt: _u, ...row } = primary;
        try {
            await this.repositories.add(row);
        } catch (e) {
            // A primary already there (or a member holding its alias) leaves the rows as they are: reads stand in with primaryOf.
            if (!(e instanceof EnvironmentRepositoryConflictError)) throw e;
        }
    }
}

/**
 * An environment's repositories out of membership rows (of it, or of several
 * environments): the primary first, then the members. Never empty.
 */
function membersOf(env: EnvironmentKey & { createdAt?: string; updatedAt?: string }, all: readonly EnvironmentRepository[]): EnvironmentRepository[] {
    const rows = all.filter((r) => r.organizationId === env.organizationId && r.environmentId === env.environmentId);
    const primary = rows.find((r) => r.role === 'primary');
    // The primary is the environment's own repository whatever a row says.
    const members = rows.filter((r) => r.role === 'member' && r.repositoryId !== env.repositoryId);
    // The primary's alias is the one the cell derives, whatever a row says.
    // (repositoryAliasOf of the full name the workspace carries: the worker refuses a claim whose primary says otherwise).
    const own = primary && primary.repositoryId === env.repositoryId ? { ...primary, alias: defaultAliasOf(primary.fullName) } : primaryOf(env);
    return [own, ...members];
}

const byOrganization = <E extends { organizationId: string }>(envs: readonly E[]) => {
    const out = new Map<string, E[]>();
    for (const e of envs) out.set(e.organizationId, [...(out.get(e.organizationId) ?? []), e]);
    return out;
};

/** The members reader a use case was given, or the primary-only one over its environment store. */
export const membersOr = (
    members: RuntimeEnvironmentMembers | undefined,
    environments: Pick<ProductEnvironmentStore, 'findByRepository'> & Partial<Pick<ProductEnvironmentStore, 'get'>>,
) => members ?? RuntimeEnvironmentMembers.primaryOnly(environments);

/**
 * Every repository of an environment, which reading or acting on it needs
 * access to (its machines hold all their code). Without a members reader
 * (the older tests): its own repository only.
 */
export const environmentRepositoryIds = (
    members: RuntimeEnvironmentMembers | undefined,
    env: { organizationId: string; environmentId: string; repositoryId: string },
): Promise<string[]> => (members ? members.repositoryIdsOfEnvironment(env.organizationId, env.environmentId, [env.repositoryId]) : Promise.resolve([env.repositoryId]));
