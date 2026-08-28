/**
 * INTEGRATION TEST — Codex credential rotation against real Postgres.
 *
 * Rotation is the highest-consequence path in the Codex provider and the one
 * unit tests cover least convincingly, because they mock the repository. The
 * server invalidates the old refresh token the moment it issues a new one, so
 * a persist that silently fails, writes to the wrong tenant's row, or loses a
 * concurrent race costs the user their credential permanently.
 *
 * The compare-and-swap this depends on is also the subject of a review finding
 * claiming JSON.stringify makes it key-order sensitive. That is checked here
 * against the real database rather than argued about, since `:expected::jsonb`
 * parses into jsonb before comparing.
 *
 * Skips automatically if Postgres isn't reachable, matching the pattern in
 * test/integration/parameters/create-or-update-config-race.integration.spec.ts.
 */
require('dotenv').config();

import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { ENTITIES } from '@libs/core/infrastructure/database/typeorm/entities';
import { OrganizationParametersRepository } from '@libs/organization/infrastructure/adapters/repositories/organizationParameters.repository';
import { OrganizationParametersModel } from '@libs/organization/infrastructure/adapters/repositories/schemas/organizationParameters.model';

const PG_HOST = process.env.TEST_PG_HOST ?? 'localhost';
const PG_PORT = parseInt(
    process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? '5432',
    10,
);
const PG_USER =
    process.env.TEST_PG_USER ?? process.env.API_PG_DB_USERNAME ?? 'kodusdev';
const PG_PASSWORD =
    process.env.TEST_PG_PASSWORD ??
    process.env.API_PG_DB_PASSWORD ??
    'kodusdev';
const PG_DB =
    process.env.TEST_PG_DB ?? process.env.API_PG_DB_DATABASE ?? 'kodus_db';

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

function makeDataSource(): DataSource {
    return new DataSource({
        type: 'postgres',
        host: PG_HOST,
        port: PG_PORT,
        username: PG_USER,
        password: PG_PASSWORD,
        database: PG_DB,
        logging: false,
        synchronize: false,
        entities: ENTITIES,
    });
}

async function isPostgresReachable(): Promise<boolean> {
    const probe = makeDataSource();
    try {
        await probe.initialize();
        await probe.query('SELECT 1');
        return true;
    } catch {
        return false;
    } finally {
        if (probe.isInitialized) {
            await probe.destroy();
        }
    }
}

(skipIntegration ? describe.skip : describe)(
    'Codex credential rotation (real Postgres)',
    () => {
        jest.setTimeout(60_000);

        let dataSource: DataSource;
        let repository: OrganizationParametersRepository;

        const TEST_TAG = `codex-rot-${process.pid}-${Date.now()}`;
        const orgUuid = uuidv4();
        const otherOrgUuid = uuidv4();

        const CONFIG_KEY = 'byok_config';

        beforeAll(async () => {
            if (!(await isPostgresReachable())) {
                throw new Error(
                    `Postgres unreachable at ${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}. ` +
                        `Set TEST_PG_* env vars or run with SKIP_INTEGRATION=true to skip.`,
                );
            }

            dataSource = makeDataSource();
            await dataSource.initialize();
            repository = new OrganizationParametersRepository(
                dataSource.getRepository(OrganizationParametersModel),
            );

            for (const uuid of [orgUuid, otherOrgUuid]) {
                await dataSource.query(
                    `INSERT INTO organizations (uuid, name, status, release_track, "createdAt", "updatedAt")
                     VALUES ($1, $2, true, 'stable', NOW(), NOW())`,
                    [uuid, `org-${TEST_TAG}-${uuid.slice(0, 8)}`],
                );
            }
        });

        afterAll(async () => {
            if (!dataSource?.isInitialized) {
                return;
            }
            await dataSource.query(
                `DELETE FROM organization_parameters WHERE organization_id = ANY($1)`,
                [[orgUuid, otherOrgUuid]],
            );
            await dataSource.query(
                `DELETE FROM organizations WHERE uuid = ANY($1)`,
                [[orgUuid, otherOrgUuid]],
            );
            await dataSource.destroy();
        });

        async function seed(
            organizationId: string,
            configValue: Record<string, unknown>,
        ): Promise<string> {
            const uuid = uuidv4();
            await dataSource.query(
                `INSERT INTO organization_parameters
                     (uuid, "configKey", "configValue", organization_id, "createdAt", "updatedAt")
                 VALUES ($1, $2, $3::jsonb, $4, NOW(), NOW())`,
                [uuid, CONFIG_KEY, JSON.stringify(configValue), organizationId],
            );
            return uuid;
        }

        async function readValue(
            uuid: string,
        ): Promise<Record<string, unknown>> {
            const [row] = await dataSource.query(
                `SELECT "configValue" FROM organization_parameters WHERE uuid = $1`,
                [uuid],
            );
            return row.configValue;
        }

        it('swaps the stored credential when the expected value matches', async () => {
            const expected = {
                codexRefreshToken: 'refresh-1',
                model: 'gpt-5.6-sol',
            };
            const uuid = await seed(orgUuid, expected);

            const swapped = await repository.compareAndSwapConfigValue(
                uuid,
                expected as never,
                {
                    codexRefreshToken: 'refresh-2',
                    model: 'gpt-5.6-sol',
                } as never,
            );

            expect(swapped).toBe(true);
            expect((await readValue(uuid)).codexRefreshToken).toBe('refresh-2');
        });

        // The review finding this addresses claims JSON.stringify makes the
        // comparison order-sensitive. The `::jsonb` cast parses before
        // comparing, so a differently-ordered object must still match.
        it('matches regardless of key order in the expected value', async () => {
            const stored = {
                codexRefreshToken: 'refresh-1',
                model: 'gpt-5.6-sol',
                nested: { b: 2, a: 1 },
            };
            const uuid = await seed(orgUuid, stored);

            // Same content, different key order at both levels.
            const reordered = {
                nested: { a: 1, b: 2 },
                model: 'gpt-5.6-sol',
                codexRefreshToken: 'refresh-1',
            };

            const swapped = await repository.compareAndSwapConfigValue(
                uuid,
                reordered as never,
                { codexRefreshToken: 'refresh-2' } as never,
            );

            expect(swapped).toBe(true);
        });

        it('refuses the swap when another writer already rotated', async () => {
            const expected = { codexRefreshToken: 'refresh-1' };
            const uuid = await seed(orgUuid, expected);

            // A concurrent rotation lands first.
            await dataSource.query(
                `UPDATE organization_parameters SET "configValue" = $1::jsonb WHERE uuid = $2`,
                [JSON.stringify({ codexRefreshToken: 'refresh-winner' }), uuid],
            );

            const swapped = await repository.compareAndSwapConfigValue(
                uuid,
                expected as never,
                { codexRefreshToken: 'refresh-loser' } as never,
            );

            // The loser must not clobber the winner's token.
            expect(swapped).toBe(false);
            expect((await readValue(uuid)).codexRefreshToken).toBe(
                'refresh-winner',
            );
        });

        it('scopes the lookup to the owning organization', async () => {
            const mine = { codexRefreshToken: 'mine' };
            await seed(orgUuid, mine);
            await seed(otherOrgUuid, { codexRefreshToken: 'theirs' });

            const found = await repository.findByKeyAndValue({
                configKey: CONFIG_KEY as never,
                configValue: mine,
                organizationAndTeamData: { organizationId: orgUuid } as never,
            });

            const values = (found ?? []).map(
                (r: { configValue?: { codexRefreshToken?: string } }) =>
                    r.configValue?.codexRefreshToken,
            );
            expect(values).toContain('mine');
            expect(values).not.toContain('theirs');
        });
    },
);
