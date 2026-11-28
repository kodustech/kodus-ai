/**
 * INTEGRATION TEST: a member joining a workspace is created together with
 * their Git connection grants, against a real Postgres. Skips when Postgres
 * is not reachable.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import {
    connectTestPostgres,
    disconnectTestPostgres,
    skipPostgresIntegration,
} from '../../../../../test/helpers/postgres-integration';
import { ENTITIES } from '@libs/core/infrastructure/database/typeorm/entities';
import { UserConnectionAccessRepository } from '@libs/identity/infrastructure/adapters/repositories/userConnectionAccess.repository';
import { TeamMemberModel } from './schemas/teamMember.model';
import { TeamMemberDatabaseRepository } from './teamMember.repository';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

(skipPostgresIntegration ? describe.skip : describe)(
    'TeamMemberDatabaseRepository.create with grants (integration, real Postgres)',
    () => {
        let ds: DataSource | undefined;
        let members: TeamMemberDatabaseRepository;
        let access: UserConnectionAccessRepository;
        const organizationId = randomUUID();
        const teamId = randomUUID();
        const [joining, failing] = [randomUUID(), randomUUID()];
        const [active, inactive, otherTeam] = [
            randomUUID(),
            randomUUID(),
            randomUUID(),
        ];

        const grantsOf = async (userId: string) =>
            (
                (await ds!.query(
                    `SELECT "integration_id" FROM "user_connection_access"
                      WHERE "user_id" = $1 ORDER BY "integration_id"`,
                    [userId],
                )) as Array<{ integration_id: string }>
            ).map((row) => row.integration_id);

        const memberRows = async (userId: string) =>
            (await ds!.query(
                `SELECT 1 FROM "team_member" WHERE "user_id" = $1`,
                [userId],
            )) as unknown[];

        const member = (userId: string) => ({
            name: 'member',
            status: true,
            user: { uuid: userId },
            team: { uuid: teamId },
            organization: { uuid: organizationId },
        });

        beforeAll(async () => {
            ds = await connectTestPostgres({
                replica: true,
                entities: ENTITIES,
            });
            if (!ds) return;
            members = new TeamMemberDatabaseRepository(
                ds.getRepository(TeamMemberModel),
            );
            access = new UserConnectionAccessRepository({
                manager: ds.manager,
            } as any);
            await ds.query(
                `INSERT INTO "organizations" ("uuid", "name") VALUES ($1, 'org')`,
                [organizationId],
            );
            await ds.query(
                `INSERT INTO "teams" ("uuid", "name", "organization_id") VALUES ($1, 'team', $2)`,
                [teamId, organizationId],
            );
            await ds.query(
                `INSERT INTO "users" ("uuid", "email", "password", "organization_id")
                 VALUES ($1, $3, 'x', $5), ($2, $4, 'x', $5)`,
                [
                    joining,
                    failing,
                    `${joining}@example.test`,
                    `${failing}@example.test`,
                    organizationId,
                ],
            );
            await ds.query(
                `INSERT INTO "integrations" ("uuid", "status", "platform", "integrationCategory", "organization_id", "team_id")
                 VALUES ($1, true, 'GITHUB', 'CODE_MANAGEMENT', $4, $5),
                        ($2, false, 'GITLAB', 'CODE_MANAGEMENT', $4, $5),
                        ($3, true, 'GITLAB', 'CODE_MANAGEMENT', $4, NULL)`,
                [active, inactive, otherTeam, organizationId, teamId],
            );
        });

        afterAll(async () => {
            if (!ds) return;
            await ds.query(
                `DELETE FROM "user_connection_access" WHERE "user_id" = ANY($1::uuid[])`,
                [[joining, failing]],
            );
            await ds.query(
                `DELETE FROM "team_member" WHERE "user_id" = ANY($1::uuid[])`,
                [[joining, failing]],
            );
            await ds.query(
                `DELETE FROM "integrations" WHERE "uuid" = ANY($1::uuid[])`,
                [[active, inactive, otherTeam]],
            );
            await ds.query(
                `DELETE FROM "users" WHERE "uuid" = ANY($1::uuid[])`,
                [[joining, failing]],
            );
            await ds.query(`DELETE FROM "teams" WHERE "uuid" = $1`, [teamId]);
            await ds.query(`DELETE FROM "organizations" WHERE "uuid" = $1`, [
                organizationId,
            ]);
            await disconnectTestPostgres(ds);
        });

        it("creates the member with the workspace's active Git connections granted", async () => {
            if (!ds) return;

            await members.create(member(joining) as any, {
                alsoWithin: (runner) =>
                    access.grantWorkspaceConnections(joining, teamId, runner),
            });

            expect(await memberRows(joining)).toHaveLength(1);
            expect(await grantsOf(joining)).toEqual([active]);
        });

        it('creates no member when the grant cannot be written', async () => {
            if (!ds) return;

            const result = await members.create(member(failing) as any, {
                alsoWithin: async (runner) => {
                    await access.grantWorkspaceConnections(
                        failing,
                        teamId,
                        runner,
                    );
                    throw new Error('grant write failed');
                },
            });

            expect(result).toBeInstanceOf(Error);
            expect(await memberRows(failing)).toEqual([]);
            expect(await grantsOf(failing)).toEqual([]);
        });
    },
);
