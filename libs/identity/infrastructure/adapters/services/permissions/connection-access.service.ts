import { Injectable } from '@nestjs/common';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { createLogger } from '@libs/core/log/logger';
import {
    ConnectionRepositoryList,
    UserConnectionAccessRepository,
} from '@libs/identity/infrastructure/adapters/repositories/userConnectionAccess.repository';

/**
 * What a non-owner member may read across the organization's Git
 * connections: everything when granted every connection, otherwise the
 * repositories of the granted ones.
 */
export type ConnectionReadScope =
    | { kind: 'all' }
    | {
          kind: 'connections';
          connectionIds: string[];
          repositoryIds: string[];
          /** Lower-cased names the repositories go by: full name, owner/name and name. */
          repositoryNames: string[];
      };

type ScopeUser = {
    uuid?: string;
    role?: string;
    organization?: { uuid?: string };
};

/**
 * What a member who is not granted every Git connection may read. Absent
 * (`null`) for owners and members granted every connection.
 */
export type ConnectionRestriction = {
    connectionIds: ReadonlySet<string>;
    repositoryIds: ReadonlySet<string>;
    allowsRepository(repository: { id?: unknown; name?: unknown }): boolean;
};

type StoredRepository = {
    id?: unknown;
    name?: string;
    full_name?: string;
    organizationName?: string;
};

/** Grants change rarely; a short memory spares a query on every check. */
const SCOPE_TTL_MS = 15_000;

const NO_CONNECTION: ConnectionReadScope = {
    kind: 'connections',
    connectionIds: [],
    repositoryIds: [],
    repositoryNames: [],
};

const repositoriesOf = (list: ConnectionRepositoryList): StoredRepository[] =>
    Array.isArray(list.repositories)
        ? (list.repositories as StoredRepository[])
        : [];

const idsOf = (repositories: StoredRepository[]) =>
    repositories.map((repository) => String(repository?.id));

/** Only owner/name forms: a bare name is not unique. */
const namesOf = (repositories: StoredRepository[]) =>
    repositories.flatMap((repository) =>
        [
            repository?.full_name,
            repository?.organizationName && repository?.name
                ? `${repository.organizationName}/${repository.name}`
                : undefined,
            repository?.name,
        ]
            .filter(
                (name): name is string =>
                    typeof name === 'string' && name.includes('/'),
            )
            .map((name) => name.toLowerCase()),
    );

/** Who reads which Git connections of the organization. */
@Injectable()
export class ConnectionAccessService {
    private readonly logger = createLogger(ConnectionAccessService.name);
    private readonly scopes = new Map<
        string,
        { scope: ConnectionReadScope; expiresAt: number }
    >();
    /** Bumped when a user's grants change, so a read already under way is not remembered. */
    private readonly generations = new Map<string, number>();

    constructor(private readonly access: UserConnectionAccessRepository) {}

    async readScopeFor(user: ScopeUser): Promise<ConnectionReadScope> {
        const userId = user?.uuid;
        const organizationId = user?.organization?.uuid;
        if (!userId || !organizationId) return NO_CONNECTION;

        const cached = this.scopes.get(this.key(organizationId, userId));
        if (cached && cached.expiresAt > Date.now()) return cached.scope;

        const [scope] = (
            await this.loadScopes(organizationId, [userId])
        ).values();
        return scope;
    }

    async restrictionFor(
        user: ScopeUser,
    ): Promise<ConnectionRestriction | null> {
        if (user?.role === Role.OWNER) return null;
        return this.restrictionOf(await this.readScopeFor(user));
    }

    /**
     * `restrictionFor` for many members of one organization, read in one
     * pass instead of one lookup per member.
     */
    async restrictionsFor(
        users: ScopeUser[],
    ): Promise<Map<string, ConnectionRestriction | null>> {
        const restrictions = new Map<string, ConnectionRestriction | null>();
        const byOrganization = new Map<string, string[]>();
        for (const user of users) {
            if (!user?.uuid) continue;
            const organizationId = user.organization?.uuid;
            if (user.role === Role.OWNER) {
                restrictions.set(user.uuid, null);
            } else if (!organizationId) {
                restrictions.set(user.uuid, this.restrictionOf(NO_CONNECTION));
            } else {
                const cached = this.scopes.get(
                    this.key(organizationId, user.uuid),
                );
                if (cached && cached.expiresAt > Date.now()) {
                    restrictions.set(
                        user.uuid,
                        this.restrictionOf(cached.scope),
                    );
                } else {
                    byOrganization.set(organizationId, [
                        ...(byOrganization.get(organizationId) ?? []),
                        user.uuid,
                    ]);
                }
            }
        }
        for (const [organizationId, userIds] of byOrganization) {
            const scopes = await this.loadScopes(organizationId, userIds);
            for (const [userId, scope] of scopes) {
                restrictions.set(userId, this.restrictionOf(scope));
            }
        }
        return restrictions;
    }

    private restrictionOf(
        scope: ConnectionReadScope,
    ): ConnectionRestriction | null {
        if (scope.kind === 'all') return null;
        const repositoryIds = new Set(scope.repositoryIds);
        const repositoryNames = new Set(scope.repositoryNames);
        return {
            connectionIds: new Set(scope.connectionIds),
            repositoryIds,
            allowsRepository: ({ id, name }) =>
                (id != null && repositoryIds.has(String(id))) ||
                (typeof name === 'string' &&
                    repositoryNames.has(name.toLowerCase())),
        };
    }

    /**
     * Repository ids and names repeat across servers. One listed by a
     * connection the member is not granted, disabled ones included (their
     * records remain), is left out: records keyed by the bare id cannot tell
     * the two repositories apart.
     */
    private async loadScopes(
        organizationId: string,
        userIds: string[],
    ): Promise<Map<string, ConnectionReadScope>> {
        const startedAt = new Map(
            userIds.map((userId) => [userId, this.generationOf(userId)]),
        );
        const [connections, grants] = await Promise.all([
            this.access.activeConnectionIds(organizationId),
            this.access.grantsOf(userIds),
        ]);
        const live = new Set(connections);
        const anyPartial = userIds.some(
            (userId) =>
                (grants.get(userId) ?? []).filter((id) => live.has(id))
                    .length !== connections.length,
        );
        const lists = anyPartial
            ? await this.access.repositoryLists(
                  organizationId,
                  await this.access.allConnectionIds(organizationId),
              )
            : [];

        const scopes = new Map<string, ConnectionReadScope>();
        for (const userId of userIds) {
            const granted = new Set(
                (grants.get(userId) ?? []).filter((id) => live.has(id)),
            );
            const scope: ConnectionReadScope =
                granted.size === connections.length
                    ? { kind: 'all' }
                    : this.partialScope(granted, lists);
            scopes.set(userId, scope);
            if (startedAt.get(userId) !== this.generationOf(userId)) continue;
            this.scopes.set(this.key(organizationId, userId), {
                scope,
                expiresAt: Date.now() + SCOPE_TTL_MS,
            });
        }
        return scopes;
    }

    private partialScope(
        granted: ReadonlySet<string>,
        lists: ConnectionRepositoryList[],
    ): ConnectionReadScope {
        const mine = lists
            .filter((list) => granted.has(list.integrationId))
            .flatMap(repositoriesOf);
        const others = lists
            .filter((list) => !granted.has(list.integrationId))
            .flatMap(repositoriesOf);
        const otherIds = new Set(idsOf(others));
        const otherNames = new Set(namesOf(others));
        return {
            kind: 'connections',
            connectionIds: [...granted],
            repositoryIds: [
                ...new Set(idsOf(mine).filter((id) => !otherIds.has(id))),
            ],
            repositoryNames: [
                ...new Set(
                    namesOf(mine).filter((name) => !otherNames.has(name)),
                ),
            ],
        };
    }

    connectionInWorkspace(
        organizationId: string,
        teamId: string,
        integrationId: string,
    ): Promise<boolean> {
        return this.access.connectionInWorkspace(
            organizationId,
            teamId,
            integrationId,
        );
    }

    /** The workspace's active Git connections. */
    workspaceConnectionIds(teamId: string): Promise<string[]> {
        return this.access.workspaceConnectionIds(teamId);
    }

    connectionInOrganization(
        organizationId: string,
        integrationId: string,
    ): Promise<boolean> {
        return this.access.connectionInOrganization(
            organizationId,
            integrationId,
        );
    }

    /** The given users that belong to the organization. */
    membersOfOrganization(
        organizationId: string,
        userIds: string[],
    ): Promise<string[]> {
        return this.access.membersOfOrganization(organizationId, userIds);
    }

    listGrants(integrationId: string): Promise<string[]> {
        return this.access.listGrants(integrationId);
    }

    /**
     * Sets exactly who reads the connection. Concurrent replaces of one
     * connection run one after the other, each against what the last wrote.
     */
    async replaceGrants(
        integrationId: string,
        userIds: string[],
    ): Promise<{ granted: string[]; revoked: string[] }> {
        const diff = await this.access.replaceGrants(integrationId, userIds);
        this.forget([...diff.granted, ...diff.revoked]);
        return diff;
    }

    /** A member who joins a workspace reads its Git connections. */
    async grantWorkspaceConnections(
        userId: string,
        teamId: string,
    ): Promise<void> {
        const connections = await this.access.workspaceConnectionIds(teamId);
        await this.access.grant(
            connections.map((integrationId) => ({ userId, integrationId })),
        );
        this.forget([userId]);
    }

    /** Every member of the workspace reads the connection. */
    async grantWorkspaceMembers(
        teamId: string,
        integrationId: string,
    ): Promise<string[]> {
        const members = await this.access.workspaceMemberIds(teamId);
        await this.access.grant(
            members.map((userId) => ({ userId, integrationId })),
        );
        this.forget(members);
        return members;
    }

    /** The user reads every Git connection of the organization. */
    async grantOrganizationConnections(
        userId: string,
        organizationId: string,
    ): Promise<void> {
        const connections =
            await this.access.activeConnectionIds(organizationId);
        await this.access.grant(
            connections.map((integrationId) => ({ userId, integrationId })),
        );
        this.forget([userId]);
    }

    async revoke(integrationId: string, userIds: string[]): Promise<void> {
        await this.access.revoke(integrationId, userIds);
        this.forget(userIds);
    }

    private key(organizationId: string, userId: string) {
        return `${organizationId}:${userId}`;
    }

    private generationOf(userId: string): number {
        return this.generations.get(userId) ?? 0;
    }

    private forget(userIds: string[]): void {
        const users = new Set(userIds);
        for (const userId of users) {
            this.generations.set(userId, this.generationOf(userId) + 1);
        }
        for (const key of this.scopes.keys()) {
            if (users.has(key.slice(key.lastIndexOf(':') + 1))) {
                this.scopes.delete(key);
            }
        }
    }
}
