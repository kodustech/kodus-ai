import { Client } from 'pg';

import { PrDecisionRecordModel } from '@libs/code-review/infrastructure/adapters/repositories/schemas/prDecisionRecord.model';
import { PrDecisionRecordRepository } from '@libs/code-review/infrastructure/adapters/repositories/prDecisionRecord.repository';
import { PrDecisionController } from './pr-decision.controller';

const DB_HOST = process.env.API_PG_DB_HOST ?? 'localhost';
const DB_PORT = parseInt(process.env.API_PG_DB_PORT ?? '5432', 10);
const DB_USER = process.env.API_PG_DB_USERNAME ?? 'kodusdev';
const DB_PASS = process.env.API_PG_DB_PASSWORD ?? '123456';
const DB_NAME = process.env.API_PG_DB_DATABASE ?? 'kodus_db';

const shouldRun = process.env.API_PG_DB_HOST !== undefined;

(shouldRun ? describe : describe.skip)('PrDecisionController (real DB)', () => {
    let client: Client;
    let orgId: string;
    let repoId: string;
    let head: string;
    let repo: PrDecisionRecordRepository;
    let controller: PrDecisionController;

    beforeAll(async () => {
        client = new Client({
            host: DB_HOST,
            port: DB_PORT,
            user: DB_USER,
            password: DB_PASS,
            database: DB_NAME,
        });
        await client.connect();
        orgId = `00000000-0000-0000-0000-${randomSuffix()}`;
        repoId = `00000000-0000-0000-0000-${randomSuffix()}`;
        head = 'cccccccccccccccccccccccccccccccccccccccc';

        await client.query(
            `INSERT INTO pr_decision_records
                (organization_id, repository_id, pr_number, head_sha, base_sha,
                 configuration_key, gate_verdicts_snapshot, last_apply_outcome,
                 last_reconciled_at)
             VALUES ($1, $2, 142, $3, 'b', 'c', $4::jsonb, $5::jsonb, NOW())`,
            [
                orgId,
                repoId,
                head,
                JSON.stringify({
                    snapshotKey: 'c',
                    capturedAt: '2026-11-20T12:00:00.000Z',
                    l0: { ready: true, value: [] },
                }),
                JSON.stringify({
                    kind: 'applied',
                    steps: [],
                    decidedAt: '2026-11-20T12:00:00.000Z',
                }),
            ],
        );

        const dataSource = {
            // TypeORM Repository<PrDecisionRecordModel> adapter over the same DB
            // is overkill; we go through a thin in-memory proxy that maps to
            // the seed row. The point of this spec is the controller's
            // response shape, not the repository (covered by its own spec).
            findOne: async (
                where: Partial<PrDecisionRecordModel>,
            ): Promise<PrDecisionRecordModel | null> => {
                const rows = await client.query(
                    `SELECT * FROM pr_decision_records
                     WHERE organization_id = $1 AND repository_id = $2
                       AND pr_number = $3 AND head_sha = $4`,
                    [
                        where.organizationId,
                        where.repositoryId,
                        where.prNumber,
                        where.headSha,
                    ],
                );
                if (rows.rowCount === 0) return null;
                const r = rows.rows[0];
                return {
                    uuid: r.uuid,
                    organizationId: r.organization_id,
                    repositoryId: r.repository_id,
                    prNumber: r.pr_number,
                    headSha: r.head_sha,
                    baseSha: r.base_sha,
                    configurationKey: r.configuration_key,
                    gateVerdictsSnapshot: r.gate_verdicts_snapshot,
                    lastApplyOutcome: r.last_apply_outcome,
                    lastReconciledAt: r.last_reconciled_at,
                    consecutiveFailures: r.consecutive_failures,
                    inFlightTriggerKind: r.in_flight_trigger_kind,
                    createdAt: r.created_at,
                    updatedAt: r.updated_at,
                } as PrDecisionRecordModel;
            },
        };

        repo = {
            findByRecordKey: async (key) =>
                dataSource.findOne({
                    organizationId: key.organizationId,
                    repositoryId: key.repositoryId,
                    prNumber: key.prNumber,
                    headSha: key.headSha,
                }),
        } as unknown as PrDecisionRecordRepository;

        controller = new PrDecisionController(
            {
                user: { organization: { uuid: orgId } },
            } as any,
            repo,
        );
    });

    afterAll(async () => {
        await client.query(
            'DELETE FROM pr_decision_records WHERE organization_id = $1',
            [orgId],
        );
        await client.end();
    });

    it('returns the read-shaped projection for an authorized tenant', async () => {
        const result = await controller.readDecision(repoId, '142', head);
        expect(result).toMatchObject({
            organizationId: orgId,
            repositoryId: repoId,
            prNumber: 142,
            headSha: head,
            configurationKey: 'c',
        });
        expect(result.lastReconciledAt).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
        );
    });

    it('returns 404 when the head SHA is missing', async () => {
        await expect(
            controller.readDecision(repoId, '142', ''),
        ).rejects.toMatchObject({ status: 404 });
    });

    it('returns 404 when the prNumber is non-numeric', async () => {
        await expect(
            controller.readDecision(repoId, 'not-a-number', head),
        ).rejects.toMatchObject({ status: 404 });
    });

    it('returns 404 when the row does not exist', async () => {
        await expect(
            controller.readDecision(
                repoId,
                '142',
                'ffffffffffffffffffffffffffffffffffffffff',
            ),
        ).rejects.toMatchObject({ status: 404 });
    });
});

function randomSuffix(): string {
    return Math.floor(Math.random() * 1e12)
        .toString(16)
        .padStart(12, '0')
        .slice(0, 12);
}
