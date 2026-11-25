import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { createLogger } from '@libs/core/log/logger';
import { UserConnectionAccessModel } from '@libs/identity/infrastructure/adapters/repositories/schemas/userConnectionAccess.model';

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

/** Grants change rarely; a short memory spares a query on every check. */
const SCOPE_TTL_MS = 15_000;

@Injectable()
export class ConnectionAccessService {
    private readonly logger = createLogger(ConnectionAccessService.name);
    private readonly scopes = new Map<
        string,
        { scope: ConnectionReadScope; expiresAt: number }
    >();

    constructor(
        @InjectRepository(UserConnectionAccessModel)
        private readonly repository: Repository<UserConnectionAccessModel>,
    ) {}

    async readScopeFor(user: ScopeUser): Promise<ConnectionReadScope> {
        const userId = user?.uuid;
        const organizationId = user?.organization?.uuid;
        if (!userId || !organizationId) {
            return {
                kind: 'connections',
                connectionIds: [],
                repositoryIds: [],
                repositoryNames: [],
            };
        }

        const key = `${organizationId}:${userId}`;
        const cached = this.scopes.get(key);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.scope;
        }

        const scope = await this.loadScope(organizationId, userId);
        this.scopes.set(key, { scope, expiresAt: Date.now() + SCOPE_TTL_MS });
        return scope;
    }

    private async loadScope(
        organizationId: string,
        userId: string,
    ): Promise<ConnectionReadScope> {
        const [connections, grants] = await Promise.all([
            this.repository.manager.query(
                `SELECT i."uuid"
                   FROM "integrations" i
                  WHERE i."organization_id" = $1
                    AND i."status" = true
                    AND i."integrationCategory" = 'CODE_MANAGEMENT'`,
                [organizationId],
            ) as Promise<Array<{ uuid: string }>>,
            this.repository.manager.query(
                `SELECT a."integration_id"
                   FROM "user_connection_access" a
                  WHERE a."user_id" = $1`,
                [userId],
            ) as Promise<Array<{ integration_id: string }>>,
        ]);

        const granted = new Set(grants.map((g) => g.integration_id));
        const connectionIds = connections
            .map((c) => c.uuid)
            .filter((uuid) => granted.has(uuid));

        if (connectionIds.length === connections.length) {
            return { kind: 'all' };
        }

        const configs = connectionIds.length
            ? ((await this.repository.manager.query(
                  `SELECT ic."configValue"
                     FROM "integration_configs" ic
                    WHERE ic."configKey" = 'repositories'
                      AND ic."integration_id" IN (
                          SELECT i."uuid" FROM "integrations" i
                           WHERE i."organization_id" = $1
                             AND i."uuid" = ANY($2::uuid[])
                      )`,
                  [organizationId, connectionIds],
              )) as Array<{ configValue: unknown }>)
            : [];

        type StoredRepository = {
            id?: unknown;
            name?: string;
            full_name?: string;
            organizationName?: string;
        };
        const repositories = configs.flatMap((config) =>
            Array.isArray(config.configValue)
                ? (config.configValue as StoredRepository[])
                : [],
        );
        const repositoryIds = [
            ...new Set(
                repositories.map((repository) => String(repository?.id)),
            ),
        ];
        const repositoryNames = [
            ...new Set(
                repositories.flatMap((repository) =>
                    [
                        repository?.full_name,
                        repository?.organizationName && repository?.name
                            ? `${repository.organizationName}/${repository.name}`
                            : undefined,
                        repository?.name,
                    ]
                        // Only owner/name forms: a bare name is not unique.
                        .filter(
                            (name): name is string =>
                                typeof name === 'string' && name.includes('/'),
                        )
                        .map((name) => name.toLowerCase()),
                ),
            ),
        ];

        return {
            kind: 'connections',
            connectionIds,
            repositoryIds,
            repositoryNames,
        };
    }

    async restrictionFor(
        user: ScopeUser,
    ): Promise<ConnectionRestriction | null> {
        if (user?.role === Role.OWNER) return null;
        const scope = await this.readScopeFor(user);
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

    async connectionInWorkspace(
        organizationId: string,
        teamId: string,
        integrationId: string,
    ): Promise<boolean> {
        const rows = (await this.repository.manager.query(
            `SELECT 1 FROM "integrations" i
              WHERE i."uuid" = $1
                AND i."organization_id" = $2
                AND i."team_id" = $3
                AND i."integrationCategory" = 'CODE_MANAGEMENT'`,
            [integrationId, organizationId, teamId],
        )) as unknown[];
        return rows.length > 0;
    }

    /** The given users that belong to the organization. */
    async membersOfOrganization(
        organizationId: string,
        userIds: string[],
    ): Promise<string[]> {
        if (!userIds.length) return [];
        const rows = (await this.repository.manager.query(
            `SELECT u."uuid" FROM "users" u
              WHERE u."organization_id" = $1
                AND u."uuid" = ANY($2::uuid[])`,
            [organizationId, userIds],
        )) as Array<{ uuid: string }>;
        return rows.map((row) => row.uuid);
    }

    async listGrants(integrationId: string): Promise<string[]> {
        const rows = (await this.repository.manager.query(
            `SELECT a."user_id" FROM "user_connection_access" a
              WHERE a."integration_id" = $1`,
            [integrationId],
        )) as Array<{ user_id: string }>;
        return rows.map((row) => row.user_id);
    }

    /**
     * Sets exactly who reads the connection. Concurrent replaces of one
     * connection run one after the other, each against what the last wrote.
     */
    async replaceGrants(
        integrationId: string,
        userIds: string[],
    ): Promise<{ granted: string[]; revoked: string[] }> {
        const diff = await this.repository.manager.transaction(async (tx) => {
            await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
                `user_connection_access:${integrationId}`,
            ]);
            const rows = (await tx.query(
                `SELECT a."user_id" FROM "user_connection_access" a
                  WHERE a."integration_id" = $1`,
                [integrationId],
            )) as Array<{ user_id: string }>;
            const current = new Set(rows.map((row) => row.user_id));
            const wanted = new Set(userIds);
            const granted = [...wanted].filter((id) => !current.has(id));
            const revoked = [...current].filter((id) => !wanted.has(id));

            if (granted.length) {
                await tx.query(
                    `INSERT INTO "user_connection_access" ("user_id", "integration_id")
                     SELECT u, $1::uuid FROM unnest($2::uuid[]) AS u
                     ON CONFLICT ("user_id", "integration_id") DO NOTHING`,
                    [integrationId, granted],
                );
            }
            if (revoked.length) {
                await tx.query(
                    `DELETE FROM "user_connection_access"
                      WHERE "integration_id" = $1 AND "user_id" = ANY($2::uuid[])`,
                    [integrationId, revoked],
                );
            }
            return { granted, revoked };
        });

        this.forget([...diff.granted, ...diff.revoked]);
        return diff;
    }

    /** Grants each user read access to the connection; existing grants stay. */
    async grant(integrationId: string, userIds: string[]): Promise<void> {
        if (!userIds.length) return;
        await this.repository.manager.query(
            `INSERT INTO "user_connection_access" ("user_id", "integration_id")
             SELECT u, $1::uuid FROM unnest($2::uuid[]) AS u
             ON CONFLICT ("user_id", "integration_id") DO NOTHING`,
            [integrationId, userIds],
        );
        this.forget(userIds);
    }

    async revoke(integrationId: string, userIds: string[]): Promise<void> {
        if (!userIds.length) return;
        await this.repository.manager.query(
            `DELETE FROM "user_connection_access"
              WHERE "integration_id" = $1 AND "user_id" = ANY($2::uuid[])`,
            [integrationId, userIds],
        );
        this.forget(userIds);
    }

    private forget(userIds: string[]): void {
        for (const key of this.scopes.keys()) {
            if (userIds.some((userId) => key.endsWith(`:${userId}`))) {
                this.scopes.delete(key);
            }
        }
    }
}
