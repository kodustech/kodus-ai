import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

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
      };

type ScopeUser = { uuid?: string; organization?: { uuid?: string } };

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

        const repositoryIds = [
            ...new Set(
                configs.flatMap((config) =>
                    Array.isArray(config.configValue)
                        ? (config.configValue as Array<{ id?: unknown }>).map(
                              (repository) => String(repository?.id),
                          )
                        : [],
                ),
            ),
        ];

        return { kind: 'connections', connectionIds, repositoryIds };
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
