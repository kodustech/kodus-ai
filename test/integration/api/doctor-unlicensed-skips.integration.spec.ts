/**
 * INTEGRATION TEST — the doctor's missing-seat count (real Postgres, #2021).
 *
 * UNLICENSED_SKIPS_SQL runs against temp tables that shadow automation_execution,
 * team_automations and code_review_execution (pg_temp is searched first), so the
 * query is exercised by Postgres itself without touching the real rows or their
 * foreign keys.
 *
 * Skips automatically if Postgres isn't reachable, matching
 * test/integration/parameters/create-or-update-config-race.integration.spec.ts.
 */
require('dotenv').config();

import { DataSource, QueryRunner } from 'typeorm';

import {
    UNLICENSED_SKIPS_SQL,
    unlicensedSkipsParams,
} from '../../../apps/api/src/doctor/self-hosted-doctor.service';

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

const TEAM = 'team-under-test';
const OTHER_TEAM = 'another-team';
const NOT_LICENSED = 'User Not Licensed — Assign seat to user';

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
        entities: [],
    });
}

async function isPostgresReachable(): Promise<boolean> {
    const probe = makeDataSource();
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

describe('doctor missing-seat count (real Postgres)', () => {
    let dataSource: DataSource;
    let runner: QueryRunner;
    let reachable = false;
    let seq = 0;
    const now = Date.now();
    const since = new Date(now - 14 * 86_400_000);
    const minutesAgo = (m: number) => new Date(now - m * 60_000);

    async function execution(opts: {
        team?: string;
        repo: string;
        pr: number;
        status: string;
        errorMessage?: string | null;
        stageMessage?: string;
        at: Date;
    }): Promise<void> {
        const uuid = `ae-${++seq}`;
        await runner.query(
            `INSERT INTO automation_execution (uuid, team_automation_id, "repositoryId", "pullRequestNumber", status, "errorMessage", "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                uuid,
                opts.team === OTHER_TEAM ? 'ta-other' : 'ta-main',
                opts.repo,
                opts.pr,
                opts.status,
                opts.errorMessage ?? null,
                opts.at,
            ],
        );
        if (opts.stageMessage) {
            await runner.query(
                `INSERT INTO code_review_execution (automation_execution_id, message) VALUES ($1, $2)`,
                [uuid, opts.stageMessage],
            );
        }
    }

    async function count(): Promise<number> {
        const [row] = await runner.query(
            UNLICENSED_SKIPS_SQL,
            unlicensedSkipsParams(TEAM, since),
        );
        return row.count;
    }

    beforeAll(async () => {
        if (skipIntegration) return;
        reachable = await isPostgresReachable();
        if (!reachable) return;
        dataSource = makeDataSource();
        await dataSource.initialize();
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        if (!reachable) return;
        runner = dataSource.createQueryRunner();
        await runner.connect();
        await runner.query(
            `CREATE TEMP TABLE team_automations (uuid text, "teamUuid" text)`,
        );
        await runner.query(
            `CREATE TEMP TABLE automation_execution (uuid text, team_automation_id text, "repositoryId" text, "pullRequestNumber" int, status text, "errorMessage" text, "createdAt" timestamptz)`,
        );
        await runner.query(
            `CREATE TEMP TABLE code_review_execution (automation_execution_id text, message text)`,
        );
        await runner.query(
            `INSERT INTO team_automations VALUES ('ta-main', $1), ('ta-other', $2)`,
            [TEAM, OTHER_TEAM],
        );
    });

    afterEach(async () => {
        if (!reachable) return;
        // Temp tables live as long as the pooled connection, not the runner.
        await runner.query(
            'DROP TABLE IF EXISTS pg_temp.team_automations, pg_temp.automation_execution, pg_temp.code_review_execution',
        );
        await runner.release();
    });

    const itPg = (name: string, fn: () => Promise<void>) =>
        it(name, async () => {
            if (skipIntegration) {
                console.warn(`[skip] SKIP_INTEGRATION=true: ${name}`);
                return;
            }
            // This is the only end-to-end check of the seat query; a missing
            // Postgres must fail it, not make it look tested.
            expect(reachable).toBe(true);
            await fn();
        });

    itPg(
        'does not count a pull request reviewed after the seat was assigned (#2021)',
        async () => {
            await execution({
                repo: 'r1',
                pr: 1,
                status: 'skipped',
                errorMessage: NOT_LICENSED,
                at: minutesAgo(30),
            });
            await execution({
                repo: 'r1',
                pr: 1,
                status: 'success',
                at: minutesAgo(10),
            });

            expect(await count()).toBe(0);
        },
    );

    itPg(
        'counts a pull request whose latest run is still skipped for a missing seat',
        async () => {
            await execution({
                repo: 'r1',
                pr: 2,
                status: 'skipped',
                errorMessage: NOT_LICENSED,
                at: minutesAgo(30),
            });

            expect(await count()).toBe(1);
        },
    );

    itPg(
        'counts a pull request reviewed once and skipped for a missing seat afterwards',
        async () => {
            await execution({
                repo: 'r1',
                pr: 3,
                status: 'success',
                at: minutesAgo(30),
            });
            await execution({
                repo: 'r1',
                pr: 3,
                status: 'skipped',
                errorMessage: NOT_LICENSED,
                at: minutesAgo(10),
            });

            expect(await count()).toBe(1);
        },
    );

    itPg(
        'recognizes the missing-seat reason recorded only on the stage log',
        async () => {
            await execution({
                repo: 'r2',
                pr: 4,
                status: 'skipped',
                stageMessage: NOT_LICENSED,
                at: minutesAgo(5),
            });

            expect(await count()).toBe(1);
        },
    );

    itPg(
        'counts each pull request once, however many skipped runs it has',
        async () => {
            await execution({
                repo: 'r3',
                pr: 5,
                status: 'skipped',
                errorMessage: NOT_LICENSED,
                at: minutesAgo(30),
            });
            await execution({
                repo: 'r3',
                pr: 5,
                status: 'skipped',
                errorMessage: NOT_LICENSED,
                at: minutesAgo(20),
            });

            expect(await count()).toBe(1);
        },
    );

    itPg(
        'ignores runs older than the lookback window and runs of other teams',
        async () => {
            await execution({
                repo: 'r4',
                pr: 6,
                status: 'skipped',
                errorMessage: NOT_LICENSED,
                at: new Date(since.getTime() - 60_000),
            });
            await execution({
                team: OTHER_TEAM,
                repo: 'r4',
                pr: 7,
                status: 'skipped',
                errorMessage: NOT_LICENSED,
                at: minutesAgo(5),
            });

            expect(await count()).toBe(0);
        },
    );

    itPg('ignores pull requests skipped for another reason', async () => {
        await execution({
            repo: 'r5',
            pr: 8,
            status: 'skipped',
            errorMessage: 'No changed files in this pull request.',
            at: minutesAgo(5),
        });

        expect(await count()).toBe(0);
    });

    it.each([
        ['an ignored author', 'User is ignored by configuration.'],
        ['a locked PR', 'PR is Locked'],
        [
            'the centralized config repository',
            'Code reviews are disabled for the centralized config repository',
        ],
    ])(
        'a later skip before the seat gate (%s) does not hide a seat skip',
        async (_label, message) => {
            if (skipIntegration) return;
            expect(reachable).toBe(true);
            await execution({
                repo: 'r6',
                pr: 9,
                status: 'skipped',
                errorMessage: NOT_LICENSED,
                at: minutesAgo(30),
            });
            await execution({
                repo: 'r6',
                pr: 9,
                status: 'skipped',
                errorMessage: message,
                at: minutesAgo(10),
            });

            expect(await count()).toBe(1);
        },
    );

    it.each([
        ['No changed files', 'No changed files in this pull request.'],
        ['no new commits', 'No new commits since the last run.'],
    ])(
        'a later skip after the seat gate (%s) proves the seat and clears it',
        async (_label, message) => {
            if (skipIntegration) return;
            expect(reachable).toBe(true);
            await execution({
                repo: 'r7',
                pr: 10,
                status: 'skipped',
                errorMessage: NOT_LICENSED,
                at: minutesAgo(30),
            });
            await execution({
                repo: 'r7',
                pr: 10,
                status: 'skipped',
                errorMessage: message,
                at: minutesAgo(10),
            });

            expect(await count()).toBe(0);
        },
    );
});
