import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import axios from 'axios';
import { DataSource, QueryFailedError } from 'typeorm';

import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { IntegrationConfigKey } from '@libs/core/domain/enums';
import { ENTITIES } from '@libs/core/infrastructure/database/typeorm/entities';
import { AuthIntegrationRepository } from '@libs/integrations/infrastructure/adapters/repositories/authIntegration.repository';
import { IntegrationRepository } from '@libs/integrations/infrastructure/adapters/repositories/integration.repository';
import { IntegrationConfigRepository } from '@libs/integrations/infrastructure/adapters/repositories/integrationConfig.repository';
import { AuthIntegrationModel } from '@libs/integrations/infrastructure/adapters/repositories/schemas/authIntegration.model';
import { IntegrationModel } from '@libs/integrations/infrastructure/adapters/repositories/schemas/integration.model';
import { IntegrationConfigModel } from '@libs/integrations/infrastructure/adapters/repositories/schemas/integrationConfig.model';
import { AuthIntegrationService } from '@libs/integrations/infrastructure/adapters/services/authIntegration.service';
import { IntegrationService } from '@libs/integrations/infrastructure/adapters/services/integration.service';
import { IntegrationConfigService } from '@libs/integrations/infrastructure/adapters/services/integrationConfig.service';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { BitbucketDataCenterService } from '@libs/platform/infrastructure/adapters/services/bitbucket/bitbucket-data-center.service';

const describePostgres =
    process.env.SKIP_INTEGRATION === 'true' ? describe.skip : describe;

describePostgres('Bitbucket Data Center setup on Postgres', () => {
    const organizationId = randomUUID();
    const teamId = randomUUID();
    const tenant = { organizationId, teamId };
    const applicationName = `dc-setup-${teamId}`;
    const db = new DataSource({
        type: 'postgres',
        applicationName,
        host: process.env.TEST_PG_HOST ?? 'localhost',
        port: Number(
            process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? 5432,
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
            process.env.TEST_PG_DB ??
            process.env.API_PG_DB_DATABASE ??
            'kodus_db',
        entities: ENTITIES,
    });
    let dc: BitbucketDataCenterService;

    const connect = (token = 'first-token') =>
        dc.createAuthIntegration({
            organizationAndTeamData: tenant,
            token,
            authMode: AuthMode.TOKEN,
            host: 'https://bitbucket.example.test',
        });
    const counts = async () => ({
        integrations: await db
            .getRepository(IntegrationModel)
            .countBy({ team: { uuid: teamId } }),
        credentials: await db
            .getRepository(AuthIntegrationModel)
            .countBy({ team: { uuid: teamId } }),
    });
    const readPair = () =>
        db.getRepository(IntegrationModel).findOneOrFail({
            where: { team: { uuid: teamId } },
            relations: { authIntegration: true },
        });

    /** A pair as the earlier race left them: raw rows, aged on purpose. */
    const seedPair = async (opts: {
        host?: string;
        token: string;
        status: boolean;
        minutesAgo: number;
        // Leading hex digit of both row ids: without an order, Postgres
        // and TypeORM hand back the lowest id or the first insert.
        rank: string;
    }) => {
        const id = (n: string) => `${opts.rank}${n}${randomUUID().slice(2)}`;
        const at = new Date(Date.now() - opts.minutesAgo * 60_000);
        const [auth] = await db.query(
            `INSERT INTO auth_integrations (uuid, "authDetails", status, organization_id, team_id, "createdAt", "updatedAt")
             VALUES ($5, $1, true, $2, $3, $4, $4) RETURNING uuid`,
            [
                {
                    host: opts.host,
                    appPassword: encrypt(opts.token),
                    authMode: AuthMode.TOKEN,
                },
                organizationId,
                teamId,
                at,
                id('a'),
            ],
        );
        const [integration] = await db.query(
            `INSERT INTO integrations (uuid, platform, "integrationCategory", status, organization_id, team_id, auth_integration_id, "createdAt", "updatedAt")
             VALUES ($6, 'BITBUCKET', 'CODE_MANAGEMENT', $1, $2, $3, $4, $5, $5) RETURNING uuid`,
            [opts.status, organizationId, teamId, auth.uuid, at, id('b')],
        );
        return { integration: integration.uuid, auth: auth.uuid };
    };
    const tokenOf = async (authUuid: string) =>
        decrypt(
            (
                await db
                    .getRepository(AuthIntegrationModel)
                    .findOneByOrFail({ uuid: authUuid })
            ).authDetails.appPassword,
        );

    beforeAll(async () => {
        await db.initialize();
        await db.query(
            'INSERT INTO organizations (uuid, name) VALUES ($1, $2)',
            [organizationId, 'DC test'],
        );
        await db.query(
            'INSERT INTO teams (uuid, name, organization_id) VALUES ($1, $2, $3)',
            [teamId, 'DC test', organizationId],
        );
        const configs = new IntegrationConfigService(
            new IntegrationConfigRepository(
                db.getRepository(IntegrationConfigModel),
            ),
        );
        dc = new BitbucketDataCenterService(
            new IntegrationService(
                new IntegrationRepository(db.getRepository(IntegrationModel)),
                configs,
            ),
            configs,
            new AuthIntegrationService(
                new AuthIntegrationRepository(
                    db.getRepository(AuthIntegrationModel),
                ),
            ),
            undefined,
        );
    });

    beforeEach(() => {
        jest.spyOn(axios, 'create').mockReturnValue({
            get: jest
                .fn()
                .mockResolvedValue({ status: 200, data: { values: [] } }),
        } as any);
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        db.subscribers.length = 0;
        if (!db.isInitialized) return;
        await db.query('DELETE FROM integration_configs WHERE team_id = $1', [
            teamId,
        ]);
        await db.query('DELETE FROM integrations WHERE team_id = $1', [teamId]);
        await db.query('DELETE FROM auth_integrations WHERE team_id = $1', [
            teamId,
        ]);
    });

    afterAll(async () => {
        if (!db.isInitialized) return;
        await db.query('DELETE FROM teams WHERE uuid = $1', [teamId]);
        await db.query('DELETE FROM organizations WHERE uuid = $1', [
            organizationId,
        ]);
        await db.destroy();
    });

    it.each(['auth_integrations', 'integrations'])(
        'rolls back both writes when Postgres rejects the %s insert',
        async (table) => {
            // Violate the real NOT NULL constraint on this connection only.
            db.subscribers.push({
                beforeInsert(event) {
                    if (event.metadata.tableName === table)
                        event.entity.status = null;
                },
            });
            const submission = await Promise.allSettled([connect()]);
            expect({
                result: submission[0].status,
                ...(await counts()),
            }).toEqual({
                result: 'rejected',
                integrations: 0,
                credentials: 0,
            });
            db.subscribers.length = 0;
            await expect(connect()).resolves.toMatchObject({ success: true });
            expect(await counts()).toEqual({ integrations: 1, credentials: 1 });
        },
    );

    it('reuses one pair for concurrent first-time setups and rotates its credentials in place', async () => {
        // Both sessions must be waiting in Postgres before either can finish.
        // Without the setup lock they reach the FK insert after both read "no pair".
        const gate = db.createQueryRunner();
        await gate.startTransaction();
        let waiting = 0;
        let submissions: Promise<PromiseSettledResult<unknown>[]> =
            Promise.resolve([]);
        try {
            await gate.query('SELECT 1 FROM teams WHERE uuid = $1 FOR UPDATE', [
                teamId,
            ]);
            submissions = Promise.allSettled([connect(), connect()]);
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
                const [row] = await db.query(
                    `SELECT count(*)::int AS waiting FROM pg_stat_activity
                     WHERE application_name = $1 AND wait_event_type = 'Lock'`,
                    [applicationName],
                );
                waiting = row.waiting;
                if (waiting === 2) break;
                await delay(20);
            }
        } finally {
            await gate.rollbackTransaction();
            await gate.release();
            await submissions;
        }
        expect(waiting).toBe(2);
        const connected = {
            status: 'fulfilled',
            value: { success: true, status: 'SUCCESS' },
        };
        expect(await submissions).toEqual([connected, connected]);
        expect(await counts()).toEqual({ integrations: 1, credentials: 1 });
        const first = await readPair();
        await connect('rotated-token');
        const rotated = await readPair();
        expect(rotated.uuid).toBe(first.uuid);
        expect(rotated.authIntegration.uuid).toBe(first.authIntegration.uuid);
        expect(decrypt(rotated.authIntegration.authDetails.appPassword)).toBe(
            'rotated-token',
        );
    }, 15000);

    it('keeps the previous credentials when reactivation fails', async () => {
        await connect();
        const first = await readPair();
        await db
            .getRepository(IntegrationModel)
            .update(first.uuid, { status: false });
        db.subscribers.push({
            beforeUpdate(event) {
                if (event.metadata.target === IntegrationModel)
                    event.entity.status = null;
            },
        });
        // A database fault is not a refusal: it reaches the exception filter
        // as it is (a 500), like on every other provider.
        await expect(connect('replacement')).rejects.toBeInstanceOf(
            QueryFailedError,
        );
        const stored = await readPair();
        expect(stored.status).toBe(false);
        expect(decrypt(stored.authIntegration.authDetails.appPassword)).toBe(
            'first-token',
        );
    });

    it('repairs an existing integration without a credential on retry', async () => {
        const id = randomUUID();
        await db.query(
            `INSERT INTO integrations (uuid, platform, "integrationCategory", status, organization_id, team_id)
                        VALUES ($1, 'BITBUCKET', 'CODE_MANAGEMENT', true, $2, $3)`,
            [id, organizationId, teamId],
        );
        await connect();
        const repaired = await readPair();
        expect(repaired.uuid).toBe(id);
        expect(repaired.authIntegration?.authDetails.host).toBe(
            'https://bitbucket.example.test',
        );
        expect(await counts()).toEqual({ integrations: 1, credentials: 1 });
    });

    it('reads and rotates the most recent active pair when the earlier race left duplicates', async () => {
        const older = await seedPair({
            host: 'https://old.example.test',
            token: 'old-token',
            status: true,
            minutesAgo: 60,
            rank: '0',
        });
        const recent = await seedPair({
            host: 'https://bitbucket.example.test',
            token: 'recent-token',
            status: true,
            minutesAgo: 30,
            rank: 'f',
        });
        const disabled = await seedPair({
            host: 'https://disabled.example.test',
            token: 'disabled-token',
            status: false,
            minutesAgo: 1,
            rank: '7',
        });

        await expect(dc.getAuthDetails(tenant)).resolves.toMatchObject({
            integrationId: recent.integration,
            host: 'https://bitbucket.example.test',
        });

        await expect(connect('rotated-token')).resolves.toEqual({
            success: true,
            status: 'SUCCESS',
        });
        expect({
            older: await tokenOf(older.auth),
            recent: await tokenOf(recent.auth),
            disabled: await tokenOf(disabled.auth),
        }).toEqual({
            older: 'old-token',
            recent: 'rotated-token',
            disabled: 'disabled-token',
        });
        expect(await counts()).toEqual({ integrations: 3, credentials: 3 });
    });

    it('makes the team ready for reviews after it saves its first repository', async () => {
        await connect();
        await expect(
            dc.verifyConnection({ organizationAndTeamData: tenant }),
        ).resolves.toMatchObject({ isSetupComplete: false });
        await dc.createOrUpdateIntegrationConfig({
            organizationAndTeamData: tenant,
            configKey: IntegrationConfigKey.REPOSITORIES,
            configValue: [{ id: '7', name: 'api' }],
            deferWebhooks: true,
        });
        await expect(
            dc.verifyConnection({ organizationAndTeamData: tenant }),
        ).resolves.toMatchObject({
            isSetupComplete: true,
            config: { hasRepositories: true },
        });
    });
});
