/**
 * INTEGRATION TEST — Race condition in ParametersService.createOrUpdateConfig
 * for CODE_REVIEW_CONFIG.
 *
 * The current flow does three separate operations with no transaction or lock:
 *   1) findOne(team, configKey, active=true)
 *   2) update(uuid, { active: false }) on that single row
 *   3) insert({ active: true, version: existing.version + 1 })
 *
 * Two concurrent calls can both observe the same active row at step 1, both
 * deactivate the same uuid at step 2 (idempotent — only one effectively flips
 * it), and both insert a new active row at step 3. Result: 2 active rows for
 * the same (team, configKey). Once corrupted, findOne (ordered by createdAt
 * DESC) only sees the newest active row, so the older orphan stays active
 * forever — this is how a customer ended up with versions 227 and 349 both
 * marked active in production.
 *
 * The spec asserts the invariant the system should always preserve:
 *   COUNT(*) WHERE team_id=X AND configKey=Y AND active=true  <=  1
 *
 * Pre-fix: the first test fails on the concurrent path (count >= 2), and the
 * second test fails because a normal save cannot heal an already-corrupted
 * team (it only deactivates the row findOne returns, leaving the older active
 * row untouched).
 * Post-fix (transaction + bulk deactivate, or partial unique index): both
 * tests pass.
 *
 * Skips automatically if Postgres isn't reachable, matching the pattern in
 * libs/core/workflow/infrastructure/distributed-lock.service.integration.spec.ts.
 */
require('dotenv').config();

import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { ENTITIES } from '@libs/core/infrastructure/database/typeorm/entities';
import { ParametersRepository } from '@libs/organization/infrastructure/adapters/repositories/parameters.repository';
import { ParametersModel } from '@libs/organization/infrastructure/adapters/repositories/schemas/parameters.model';
import { ParametersService } from '@libs/organization/infrastructure/adapters/services/parameters.service';

// docker-compose.dev.yml exposes Postgres on host port 5432, so the host-side
// jest runner reaches it at localhost. API_PG_DB_HOST is the container-internal
// hostname which won't resolve from the host — only use it when TEST_PG_HOST is
// explicitly set (e.g. when running tests inside the api container).
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

function makeDataSource(poolMax = 8): DataSource {
    return new DataSource({
        type: 'postgres',
        host: PG_HOST,
        port: PG_PORT,
        username: PG_USER,
        password: PG_PASSWORD,
        database: PG_DB,
        logging: false,
        synchronize: false,
        // Register every model the production app uses. Registering only the
        // three we directly touch (Parameters/Team/Organization) breaks
        // TypeORM's inverse-property resolution: Team has @OneToMany to
        // TeamAutomationModel, IntegrationModel, etc., and Organization has
        // its own fan-out. Missing any of them aborts initialize() with
        // "Entity metadata for X#y was not found".
        entities: ENTITIES,
        extra: {
            max: poolMax,
            min: 1,
            idleTimeoutMillis: 60_000,
            connectionTimeoutMillis: 10_000,
        },
    });
}

async function isPostgresReachable(): Promise<boolean> {
    const probe = makeDataSource(1);
    try {
        await probe.initialize();
        await probe.query('SELECT 1');
        await probe.destroy();
        return true;
    } catch {
        try {
            await probe.destroy();
        } catch {
            // ignore
        }
        return false;
    }
}

(skipIntegration ? describe.skip : describe)(
    'ParametersService.createOrUpdateConfig — race condition (real Postgres)',
    () => {
        jest.setTimeout(60_000);

        let canRun = true;
        let dataSource: DataSource;
        let service: ParametersService;

        // Each test run is namespaced so concurrent CI shards on the same DB
        // never collide. afterAll/beforeEach clean up only this run's rows.
        const TEST_TAG = `params-race-${process.pid}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}`;
        const orgUuid = uuidv4();
        const teamUuid = uuidv4();

        beforeAll(async () => {
            const reachable = await isPostgresReachable();
            if (!reachable) {
                canRun = false;
                // Loud failure rather than silently passing — matches the
                // distributed-lock integration spec. Set SKIP_INTEGRATION=true
                // to skip when Postgres is genuinely unavailable.
                throw new Error(
                    `Postgres unreachable at ${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}. ` +
                        `Set TEST_PG_* env vars or run with SKIP_INTEGRATION=true to skip.`,
                );
            }

            dataSource = makeDataSource(8);
            await dataSource.initialize();

            const repo = new ParametersRepository(
                dataSource.getRepository(ParametersModel),
            );
            service = new ParametersService(repo);

            await dataSource.query(
                `INSERT INTO organizations (uuid, name, status, release_track, "createdAt", "updatedAt")
                 VALUES ($1, $2, true, 'stable', NOW(), NOW())`,
                [orgUuid, `org-${TEST_TAG}`],
            );
            await dataSource.query(
                `INSERT INTO teams (uuid, name, status, organization_id, "createdAt", "updatedAt")
                 VALUES ($1, $2, 'active', $3, NOW(), NOW())`,
                [teamUuid, `team-${TEST_TAG}`, orgUuid],
            );
        });

        afterAll(async () => {
            if (dataSource?.isInitialized) {
                await dataSource.query(
                    `DELETE FROM parameters WHERE team_id = $1`,
                    [teamUuid],
                );
                await dataSource.query(`DELETE FROM teams WHERE uuid = $1`, [
                    teamUuid,
                ]);
                await dataSource.query(
                    `DELETE FROM organizations WHERE uuid = $1`,
                    [orgUuid],
                );
                await dataSource.destroy();
            }
        });

        beforeEach(async () => {
            if (!canRun) return;
            await dataSource.query(
                `DELETE FROM parameters WHERE team_id = $1`,
                [teamUuid],
            );
        });

        const countActive = async (): Promise<number> => {
            const rows = await dataSource.query(
                `SELECT COUNT(*)::int AS c
                   FROM parameters
                  WHERE team_id = $1
                    AND "configKey" = $2
                    AND active = true`,
                [teamUuid, ParametersKey.CODE_REVIEW_CONFIG],
            );
            return rows[0].c;
        };

        const dispatchConcurrentSaves = async (n: number): Promise<void> => {
            const tasks = Array.from({ length: n }, (_, i) =>
                service.createOrUpdateConfig(
                    ParametersKey.CODE_REVIEW_CONFIG,
                    { marker: `attempt-${i}` } as any,
                    { teamId: teamUuid, organizationId: orgUuid },
                ),
            );
            await Promise.allSettled(tasks);
        };

        it('keeps at most one active row under concurrent saves', async () => {
            if (!canRun) return;

            // Mirror the production scenario: the team already has an active
            // config (v1) before the concurrent saves arrive.
            await service.createOrUpdateConfig(
                ParametersKey.CODE_REVIEW_CONFIG,
                { marker: 'baseline' } as any,
                { teamId: teamUuid, organizationId: orgUuid },
            );
            expect(await countActive()).toBe(1);

            // Several rounds because a single 4-way race occasionally lands
            // serial enough not to reproduce; the cumulative probability
            // across rounds makes pre-fix failure effectively deterministic.
            const ROUNDS = 8;
            const CONCURRENCY = 4;
            for (let i = 0; i < ROUNDS; i++) {
                await dispatchConcurrentSaves(CONCURRENCY);
            }

            // Contract: only ever one active row per (team, configKey).
            // Pre-fix: typically >= 2 (race produced duplicates).
            // Post-fix: 1 (transaction + bulk deactivate, or partial unique index).
            expect(await countActive()).toBe(1);
        });

        it('rejects a second active row at the DB level via the partial unique index', async () => {
            if (!canRun) return;

            // Establish a baseline active row through the service so the
            // assertion below is exercising the index against a realistic
            // starting state (not just an empty table).
            await service.createOrUpdateConfig(
                ParametersKey.CODE_REVIEW_CONFIG,
                { marker: 'baseline' } as any,
                { teamId: teamUuid, organizationId: orgUuid },
            );
            expect(await countActive()).toBe(1);

            // Direct INSERT of a second active row for the same
            // (team_id, configKey) must be rejected by Postgres. This is
            // the safety net that catches any future code path that
            // forgets to deactivate first — without the migration this
            // INSERT would have silently produced the v227+v349 production
            // state.
            const directInsert = dataSource.query(
                `INSERT INTO parameters (uuid, "configKey", "configValue", team_id, active, version, "createdAt", "updatedAt")
                 VALUES ($1, $2, $3::jsonb, $4, true, 99, NOW(), NOW())`,
                [
                    uuidv4(),
                    ParametersKey.CODE_REVIEW_CONFIG,
                    JSON.stringify({ marker: 'rogue' }),
                    teamUuid,
                ],
            );

            await expect(directInsert).rejects.toThrow(
                /UQ_parameters_one_active_per_team_key/,
            );
            expect(await countActive()).toBe(1);
        });
    },
);
