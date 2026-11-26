import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserConnectionAccessModel } from './schemas/userConnectionAccess.model';

export type ConnectionRepositoryList = {
    integrationId: string;
    repositories: unknown;
};

/** Which members read which Git connections of their organization. */
@Injectable()
export class UserConnectionAccessRepository {
    constructor(
        @InjectRepository(UserConnectionAccessModel)
        private readonly repository: Repository<UserConnectionAccessModel>,
    ) {}

    /** The organization's active Git connections. */
    async activeConnectionIds(organizationId: string): Promise<string[]> {
        const rows = (await this.repository.manager.query(
            `SELECT i."uuid"
               FROM "integrations" i
              WHERE i."organization_id" = $1
                AND i."status" = true
                AND i."integrationCategory" = 'CODE_MANAGEMENT'`,
            [organizationId],
        )) as Array<{ uuid: string }>;
        return rows.map((row) => row.uuid);
    }

    /** Every Git connection of the organization, disabled ones included. */
    async allConnectionIds(organizationId: string): Promise<string[]> {
        const rows = (await this.repository.manager.query(
            `SELECT i."uuid"
               FROM "integrations" i
              WHERE i."organization_id" = $1
                AND i."integrationCategory" = 'CODE_MANAGEMENT'`,
            [organizationId],
        )) as Array<{ uuid: string }>;
        return rows.map((row) => row.uuid);
    }

    /** The connections each of the given users is granted. */
    async grantsOf(userIds: string[]): Promise<Map<string, string[]>> {
        const grants = new Map<string, string[]>();
        if (!userIds.length) return grants;
        const rows = (await this.repository.manager.query(
            `SELECT a."user_id", a."integration_id"
               FROM "user_connection_access" a
              WHERE a."user_id" = ANY($1::uuid[])`,
            [userIds],
        )) as Array<{ user_id: string; integration_id: string }>;
        for (const row of rows) {
            grants.set(row.user_id, [
                ...(grants.get(row.user_id) ?? []),
                row.integration_id,
            ]);
        }
        return grants;
    }

    /** The repository list of each of the organization's given connections. */
    async repositoryLists(
        organizationId: string,
        connectionIds: string[],
    ): Promise<ConnectionRepositoryList[]> {
        if (!connectionIds.length) return [];
        const rows = (await this.repository.manager.query(
            `SELECT ic."integration_id", ic."configValue"
               FROM "integration_configs" ic
               JOIN "integrations" i ON i."uuid" = ic."integration_id"
              WHERE ic."configKey" = 'repositories'
                AND i."organization_id" = $1
                AND i."uuid" = ANY($2::uuid[])`,
            [organizationId, connectionIds],
        )) as Array<{ integration_id: string; configValue: unknown }>;
        return rows.map((row) => ({
            integrationId: row.integration_id,
            repositories: row.configValue,
        }));
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

    async connectionInOrganization(
        organizationId: string,
        integrationId: string,
    ): Promise<boolean> {
        const rows = (await this.repository.manager.query(
            `SELECT 1 FROM "integrations" i
              WHERE i."uuid" = $1
                AND i."organization_id" = $2
                AND i."integrationCategory" = 'CODE_MANAGEMENT'`,
            [integrationId, organizationId],
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

    /** The workspace's (team's) active members. */
    async workspaceMemberIds(teamId: string): Promise<string[]> {
        const rows = (await this.repository.manager.query(
            `SELECT DISTINCT tm."user_id"
               FROM "team_member" tm
              WHERE tm."team_id" = $1
                AND tm."status" = true
                AND tm."user_id" IS NOT NULL`,
            [teamId],
        )) as Array<{ user_id: string }>;
        return rows.map((row) => row.user_id);
    }

    /** The workspace's active Git connections. */
    async workspaceConnectionIds(teamId: string): Promise<string[]> {
        const rows = (await this.repository.manager.query(
            `SELECT i."uuid"
               FROM "integrations" i
              WHERE i."team_id" = $1
                AND i."status" = true
                AND i."integrationCategory" = 'CODE_MANAGEMENT'`,
            [teamId],
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
        return this.repository.manager.transaction(async (tx) => {
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
    }

    /** Grants each pair; existing grants stay. */
    async grant(
        pairs: Array<{ userId: string; integrationId: string }>,
    ): Promise<void> {
        if (!pairs.length) return;
        await this.repository.manager.query(
            `INSERT INTO "user_connection_access" ("user_id", "integration_id")
             SELECT * FROM unnest($1::uuid[], $2::uuid[])
             ON CONFLICT ("user_id", "integration_id") DO NOTHING`,
            [
                pairs.map((pair) => pair.userId),
                pairs.map((pair) => pair.integrationId),
            ],
        );
    }

    async revoke(integrationId: string, userIds: string[]): Promise<void> {
        if (!userIds.length) return;
        await this.repository.manager.query(
            `DELETE FROM "user_connection_access"
              WHERE "integration_id" = $1 AND "user_id" = ANY($2::uuid[])`,
            [integrationId, userIds],
        );
    }
}
