/**
 * INTEGRATION TEST — UserDatabaseRepository.update and .delete against a
 * real Postgres.
 * Skips automatically if Postgres isn't reachable, like
 * message-claim.service.integration.spec.ts.
 */
require('dotenv').config();

import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { UserDatabaseRepository } from './user.repository';
import { UserModel } from './schemas/user.model';

import { ENTITIES } from '@libs/core/infrastructure/database/typeorm/entities';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';

const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.TEST_PG_HOST ?? 'localhost',
    port: parseInt(
        process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? '5432',
        10,
    ),
    username:
        process.env.TEST_PG_USER ??
        process.env.API_PG_DB_USERNAME ??
        'kodusdev',
    password:
        process.env.TEST_PG_PASSWORD ??
        process.env.API_PG_DB_PASSWORD ??
        'kodusdev',
    database:
        process.env.TEST_PG_DB ?? process.env.API_PG_DB_DATABASE ?? 'kodus_db',
    logging: false,
    synchronize: false,
    // UserModel's relations name other models by string, so the app's whole
    // entity list has to be registered for the metadata to build.
    entities: ENTITIES,
});

/** Postgres not running or not reachable: skip. Anything else must fail. */
const UNREACHABLE = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
]);

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

(skipIntegration ? describe.skip : describe)(
    'UserDatabaseRepository (integration, real Postgres)',
    () => {
        let canRun = true;
        let repository: UserDatabaseRepository;
        const created: string[] = [];
        const createdOrganizations: string[] = [];

        const insertUser = async (status: STATUS) => {
            const uuid = randomUUID();
            await dataSource.getRepository(UserModel).insert({
                uuid,
                email: `user-repo-it-${uuid}@example.com`,
                password: 'not-a-real-hash',
                status,
            });
            created.push(uuid);
            return uuid;
        };

        beforeAll(async () => {
            try {
                await dataSource.initialize();
            } catch (error) {
                if (!UNREACHABLE.has((error as { code?: string })?.code)) {
                    throw error;
                }
                canRun = false;
                return;
            }
            repository = new UserDatabaseRepository(
                dataSource.getRepository(UserModel),
                dataSource,
            );
        });

        afterAll(async () => {
            if (dataSource.isInitialized) {
                // Rows a failing delete test may leave pointing at its user.
                if (created.length) {
                    for (const table of [
                        'DELETE FROM user_notifications WHERE user_id = ANY($1)',
                        'DELETE FROM cli_devices WHERE user_id = ANY($1)',
                    ]) {
                        await dataSource.query(table, [created]);
                    }
                }
                if (createdOrganizations.length) {
                    for (const table of [
                        'DELETE FROM team_cli_key WHERE team_id IN (SELECT uuid FROM teams WHERE organization_id = ANY($1))',
                        'DELETE FROM notification_deliveries WHERE organization_id = ANY($1)',
                        'DELETE FROM cli_devices WHERE organization_id = ANY($1)',
                        'DELETE FROM teams WHERE organization_id = ANY($1)',
                    ]) {
                        await dataSource.query(table, [createdOrganizations]);
                    }
                }
                if (created.length) {
                    await dataSource.query(
                        'DELETE FROM users WHERE uuid = ANY($1)',
                        [created],
                    );
                }
                if (createdOrganizations.length) {
                    await dataSource.query(
                        'DELETE FROM organizations WHERE uuid = ANY($1)',
                        [createdOrganizations],
                    );
                }
                await dataSource.destroy();
            }
        });

        // AcceptUserInvitationUseCase: the filter names the status it changes.
        it('returns the updated user when the filter matches a column the update changes', async () => {
            if (!canRun) return;
            const uuid = await insertUser(STATUS.PENDING);

            const updated = await repository.update(
                { uuid, status: STATUS.PENDING },
                { status: STATUS.ACTIVE, password: 'new-hash' },
            );

            expect(updated?.uuid).toBe(uuid);
            expect(updated?.status).toBe(STATUS.ACTIVE);
            expect(updated?.email).toBe(`user-repo-it-${uuid}@example.com`);
            const row = await dataSource
                .getRepository(UserModel)
                .findOneBy({ uuid });
            expect(row?.password).toBe('new-hash');
        });

        // SsoLoginUseCase, ConfirmEmailUseCase, ResetPasswordUseCase.
        it('returns the updated user when filtering by email', async () => {
            if (!canRun) return;
            const uuid = await insertUser(STATUS.PENDING_EMAIL);

            const updated = await repository.update(
                { email: `user-repo-it-${uuid}@example.com` },
                { status: STATUS.ACTIVE },
            );

            expect(updated?.uuid).toBe(uuid);
            expect(updated?.status).toBe(STATUS.ACTIVE);
        });

        // JoinOrganizationUseCase: sets the organization relation.
        it('persists a relation set by the update', async () => {
            if (!canRun) return;
            const uuid = await insertUser(STATUS.ACTIVE);
            const organizationId = randomUUID();
            await dataSource.query(
                'INSERT INTO organizations (uuid, name) VALUES ($1, $2)',
                [organizationId, `user-repo-it-${organizationId}`],
            );
            createdOrganizations.push(organizationId);

            const updated = await repository.update(
                { uuid },
                { organization: { uuid: organizationId } as any },
            );

            expect(updated?.uuid).toBe(uuid);
            const [row] = await dataSource.query(
                'SELECT organization_id FROM users WHERE uuid = $1',
                [uuid],
            );
            expect(row.organization_id).toBe(organizationId);
        });

        it('returns undefined and changes nothing when the filter matches no row', async () => {
            if (!canRun) return;
            const uuid = await insertUser(STATUS.ACTIVE);

            const updated = await repository.update(
                { uuid, status: STATUS.PENDING },
                { status: STATUS.INACTIVE },
            );

            expect(updated).toBeUndefined();
            const row = await dataSource
                .getRepository(UserModel)
                .findOneBy({ uuid });
            expect(row?.status).toBe(STATUS.ACTIVE);
        });

        it('wraps a database error and keeps it as the cause', async () => {
            if (!canRun) return;
            const uuid = await insertUser(STATUS.PENDING);
            jest.spyOn(console, 'error').mockImplementation(() => undefined);

            const failure = await repository
                .update({ uuid }, { status: 'not-a-status' as STATUS })
                .catch((error: Error) => error);

            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toBe('Failed to update user');
            expect((failure as Error).cause).toBeInstanceOf(Error);
        });

        describe('delete', () => {
            const insertOrganization = async () => {
                const organizationId = randomUUID();
                await dataSource.query(
                    'INSERT INTO organizations (uuid, name) VALUES ($1, $2)',
                    [organizationId, `user-repo-it-${organizationId}`],
                );
                createdOrganizations.push(organizationId);
                return organizationId;
            };

            // Every invited user gets a team.member_invited delivery, and
            // removing a single-team member deletes the user.
            it('deletes a user that other rows still point at', async () => {
                if (!canRun) return;
                const organizationId = await insertOrganization();
                const uuid = await insertUser(STATUS.PENDING);
                const teamId = randomUUID();
                await dataSource.query(
                    'INSERT INTO teams (uuid, name, organization_id) VALUES ($1, $2, $3)',
                    [teamId, 'user-repo-it', organizationId],
                );
                const [delivery] = await dataSource.query(
                    `INSERT INTO notification_deliveries
                        (event, criticality, channel, title, body, category,
                         "correlationId", organization_id, recipient_user_id,
                         "recipientEmail")
                     VALUES ('team.member_invited', 'system', 'email', 't',
                         'b', 'team', $1, $2, $3, 'invitee@example.com')
                     RETURNING uuid`,
                    [randomUUID(), organizationId, uuid],
                );
                await dataSource.query(
                    'INSERT INTO user_notifications (user_id, delivery_id) VALUES ($1, $2)',
                    [uuid, delivery.uuid],
                );
                await dataSource.query(
                    `INSERT INTO cli_devices ("deviceId", "deviceTokenHash", organization_id, user_id)
                     VALUES ($1, 'hash', $2, $3)`,
                    [randomUUID(), organizationId, uuid],
                );
                const [key] = await dataSource.query(
                    `INSERT INTO team_cli_key (name, "keyHash", team_id, created_by_user_id)
                     VALUES ('ci', $1, $2, $3) RETURNING uuid`,
                    [randomUUID(), teamId, uuid],
                );

                await repository.delete(uuid);

                const count = async (sql: string, params: unknown[]) =>
                    Number((await dataSource.query(sql, params))[0].count);
                expect(
                    await count('SELECT count(*) FROM users WHERE uuid = $1', [
                        uuid,
                    ]),
                ).toBe(0);
                // History stays, without the user.
                const [kept] = await dataSource.query(
                    'SELECT recipient_user_id, "recipientEmail" FROM notification_deliveries WHERE uuid = $1',
                    [delivery.uuid],
                );
                expect(kept).toEqual({
                    recipient_user_id: null,
                    recipientEmail: 'invitee@example.com',
                });
                // The in-app inbox and CLI device tokens go with the user.
                expect(
                    await count(
                        'SELECT count(*) FROM user_notifications WHERE user_id = $1',
                        [uuid],
                    ),
                ).toBe(0);
                expect(
                    await count(
                        'SELECT count(*) FROM cli_devices WHERE user_id = $1',
                        [uuid],
                    ),
                ).toBe(0);
                // The team key keeps working without its creator.
                const [teamKey] = await dataSource.query(
                    'SELECT created_by_user_id FROM team_cli_key WHERE uuid = $1',
                    [key.uuid],
                );
                expect(teamKey).toEqual({ created_by_user_id: null });
            });
        });
    },
);
