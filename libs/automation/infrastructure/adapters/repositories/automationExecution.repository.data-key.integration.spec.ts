/**
 * INTEGRATION TEST — AutomationExecutionRepository.hasPullRequestExecutionWithDataKey
 * against a real Postgres. It decides whether the no-license notice was already
 * posted on a PR (#2594), so the filter and the jsonb key test must hold on
 * real rows, which the mocked unit spec cannot show.
 *
 * Locally, an unreachable Postgres skips the suite with a warning, like
 * automationExecution.repository.pull-requests.integration.spec.ts. In CI it
 * fails.
 */
require('dotenv').config();

import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AutomationExecutionRepository } from './automationExecution.repository';
import { AutomationExecutionModel } from './schemas/automationExecution.model';

import { ENTITIES } from '@libs/core/infrastructure/database/typeorm/entities';

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
    entities: ENTITIES,
});

const UNREACHABLE = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
]);

const KEY = 'licenseNoticePostedAt';

(process.env.SKIP_INTEGRATION === 'true' ? describe.skip : describe)(
    'AutomationExecutionRepository.hasPullRequestExecutionWithDataKey (integration, real Postgres)',
    () => {
        let canRun = true;
        let repository: AutomationExecutionRepository;

        const org = randomUUID();
        const team = randomUUID();
        const automation = randomUUID();
        const otherAutomation = randomUUID();
        const REPO = '9200000001';
        const OTHER_REPO = '9200000002';

        const seed = async (row: {
            automation: string;
            repositoryId: string;
            pullRequestNumber: number;
            data?: Record<string, unknown>;
        }) => {
            await dataSource.query(
                `INSERT INTO automation_execution
                    (uuid, "createdAt", "updatedAt", status, "dataExecution",
                     "pullRequestNumber", "repositoryId", team_automation_id, origin)
                 VALUES ($1, now(), now(), 'skipped', $2, $3, $4, $5, 'webhook')`,
                [
                    randomUUID(),
                    JSON.stringify({ platformType: 'GITHUB', ...row.data }),
                    row.pullRequestNumber,
                    row.repositoryId,
                    row.automation,
                ],
            );
        };

        const has = (params: {
            automation?: string;
            repositoryId?: string;
            pullRequestNumber: number;
        }) =>
            repository.hasPullRequestExecutionWithDataKey({
                teamAutomationId: params.automation ?? automation,
                repositoryId: params.repositoryId ?? REPO,
                pullRequestNumber: params.pullRequestNumber,
                key: KEY,
            });

        beforeAll(async () => {
            try {
                await dataSource.initialize();
            } catch (error) {
                const code = (error as { code?: string })?.code ?? '';
                if (UNREACHABLE.has(code) && !process.env.CI) {
                    canRun = false;
                    console.warn(
                        `[integration] Postgres unreachable (${code}): the data-key lookup was NOT exercised.`,
                    );
                    return;
                }
                throw error;
            }

            repository = new AutomationExecutionRepository(
                dataSource.getRepository(AutomationExecutionModel),
            );

            await dataSource.query(
                `INSERT INTO organizations (uuid, name) VALUES ($1, 'it-data-key-org')`,
                [org],
            );
            await dataSource.query(
                `INSERT INTO teams (uuid, name, organization_id) VALUES ($1, 'it-data-key-team', $2)`,
                [team, org],
            );
            await dataSource.query(
                `INSERT INTO team_automations (uuid, "teamUuid") VALUES ($1, $3), ($2, $3)`,
                [automation, otherAutomation, team],
            );

            // PR 1: the first run posted the notice, a later run did not.
            await seed({
                automation,
                repositoryId: REPO,
                pullRequestNumber: 1,
                data: { [KEY]: '2026-11-22T12:00:00.000Z' },
            });
            await seed({
                automation,
                repositoryId: REPO,
                pullRequestNumber: 1,
            });
            // PR 2: runs without the notice; the key is set on PR 2 only for
            // another automation and for the same number in another repo.
            await seed({
                automation,
                repositoryId: REPO,
                pullRequestNumber: 2,
            });
            await seed({
                automation: otherAutomation,
                repositoryId: REPO,
                pullRequestNumber: 2,
                data: { [KEY]: '2026-11-22T12:00:00.000Z' },
            });
            await seed({
                automation,
                repositoryId: OTHER_REPO,
                pullRequestNumber: 2,
                data: { [KEY]: '2026-11-22T12:00:00.000Z' },
            });
            // PR 3: the key present but null is not a posted notice.
            await seed({
                automation,
                repositoryId: REPO,
                pullRequestNumber: 3,
                data: { [KEY]: null },
            });
        });

        afterAll(async () => {
            if (!dataSource.isInitialized) return;
            const automations = [automation, otherAutomation];
            await dataSource.query(
                `DELETE FROM automation_execution WHERE team_automation_id = ANY($1::uuid[])`,
                [automations],
            );
            await dataSource.query(
                `DELETE FROM team_automations WHERE uuid = ANY($1::uuid[])`,
                [automations],
            );
            await dataSource.query(`DELETE FROM teams WHERE uuid = $1`, [team]);
            await dataSource.query(
                `DELETE FROM organizations WHERE uuid = $1`,
                [org],
            );
            await dataSource.destroy();
        });

        it('finds the key on an earlier execution of the same PR', async () => {
            if (!canRun) return;
            await expect(has({ pullRequestNumber: 1 })).resolves.toBe(true);
        });

        it('ignores the key set for another automation or another repository', async () => {
            if (!canRun) return;
            await expect(has({ pullRequestNumber: 2 })).resolves.toBe(false);
            await expect(
                has({ automation: otherAutomation, pullRequestNumber: 2 }),
            ).resolves.toBe(true);
            await expect(
                has({ repositoryId: OTHER_REPO, pullRequestNumber: 2 }),
            ).resolves.toBe(true);
        });

        it('treats a null value as not set', async () => {
            if (!canRun) return;
            await expect(has({ pullRequestNumber: 3 })).resolves.toBe(false);
        });

        it('is false for a PR with no executions', async () => {
            if (!canRun) return;
            await expect(has({ pullRequestNumber: 99 })).resolves.toBe(false);
        });
    },
);
