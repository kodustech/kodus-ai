import { Client } from 'pg';

const DB_HOST = process.env.API_PG_DB_HOST ?? 'localhost';
const DB_PORT = parseInt(process.env.API_PG_DB_PORT ?? '5432', 10);
const DB_USER = process.env.API_PG_DB_USERNAME ?? 'kodusdev';
const DB_PASS = process.env.API_PG_DB_PASSWORD ?? '123456';
const DB_NAME = process.env.API_PG_DB_DATABASE ?? 'kodus_db';

/**
 * Real-DB integration test for `pr_decision_records`. Skipped automatically
 * when no Postgres host is reachable so the unit suite stays green without
 * docker; runs against the dev compose stack when env vars are present.
 */
const shouldRun = process.env.API_PG_DB_HOST !== undefined;

const expectedColumnNames = [
    'uuid',
    // CoreModel declares these two without an explicit column name, so
    // TypeORM expects them camelCased — the convention every Postgres table
    // in this codebase follows. The reconciler's first write proved it:
    // "column PrDecisionRecordModel.createdAt does not exist".
    'createdAt',
    'updatedAt',
    'organization_id',
    // The PROVIDER's repository id (Gitea's numeric id), not a Kodus uuid.
    'repository_id',
    'pr_number',
    'head_sha',
    'base_sha',
    'configuration_key',
    'gate_verdicts_snapshot',
    'last_apply_outcome',
    'last_reconciled_at',
    'consecutive_failures',
    'in_flight_trigger_kind',
] as const;

(shouldRun ? describe : describe.skip)('pr_decision_records (real DB)', () => {
    let client: Client;
    let orgId: string;
    let repoId: string;

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
        // The PROVIDER's repository id — Gitea's numeric id, GitHub's node
        // id — not a Kodus uuid. The column is varchar for that reason.
        repoId = `${randomSuffix()}`;
    });

    afterAll(async () => {
        if (!client) return;
        await client.query(
            'DELETE FROM pr_decision_records WHERE organization_id = $1 OR repository_id = $2',
            [orgId, repoId],
        );
        await client.end();
    });

    it('has the documented column set', async () => {
        const result = await client.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'pr_decision_records' AND table_schema = 'public'
             ORDER BY column_name`,
        );
        const names = result.rows.map((r) => r.column_name).sort();
        expect(names).toEqual([...expectedColumnNames].sort());
    });

    it('round-trips a row through raw SQL (column-shape contract)', async () => {
        const head = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80910';
        const base = '0f1e2d3c4b5a6987654321fedcba0123456789abc';
        const cfg = `cfg=v11;model=kodus-managed;${slug()}`;
        const snapshot = {
            snapshotKey: cfg,
            capturedAt: '2026-11-20T12:00:00.000Z',
            l0: { ready: true, value: [] },
        };
        const outcome = {
            kind: 'applied',
            steps: [],
            decidedAt: '2026-11-20T12:00:00.000Z',
        };

        await client.query(
            `INSERT INTO pr_decision_records
                (organization_id, repository_id, pr_number, head_sha, base_sha,
                 configuration_key, gate_verdicts_snapshot, last_apply_outcome,
                 last_reconciled_at)
             VALUES ($1, $2, 142, $3, $4, $5, $6::jsonb, $7::jsonb, NOW())`,
            [
                orgId,
                repoId,
                head,
                base,
                cfg,
                JSON.stringify(snapshot),
                JSON.stringify(outcome),
            ],
        );

        const read = await client.query(
            `SELECT * FROM pr_decision_records
             WHERE organization_id = $1 AND repository_id = $2
               AND pr_number = 142 AND head_sha = $3`,
            [orgId, repoId, head],
        );

        expect(read.rowCount).toBe(1);
        const row = read.rows[0];
        expect(row.base_sha).toBe(base);
        expect(row.configuration_key).toBe(cfg);
        expect(row.consecutive_failures).toBe(0);
        expect(row.gate_verdicts_snapshot).toEqual(snapshot);
        expect(row.last_apply_outcome).toEqual(outcome);
        expect(row.in_flight_trigger_kind).toBeNull();
        expect(new Date(row.last_reconciled_at).getTime()).toBeGreaterThan(0);
    });

    it('unique constraint blocks duplicate (repository_id, pr_number, head_sha)', async () => {
        const dupHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        await client.query(
            `INSERT INTO pr_decision_records
                (organization_id, repository_id, pr_number, head_sha,
                 base_sha, configuration_key, gate_verdicts_snapshot,
                 last_apply_outcome, last_reconciled_at)
             VALUES ($1, $2, 999, $3, 'b', 'c', '{}'::jsonb, '{}'::jsonb, NOW())`,
            [orgId, repoId, dupHead],
        );

        let thrown: unknown = null;
        try {
            await client.query(
                `INSERT INTO pr_decision_records
                    (organization_id, repository_id, pr_number, head_sha,
                     base_sha, configuration_key, gate_verdicts_snapshot,
                     last_apply_outcome, last_reconciled_at)
                 VALUES ($1, $2, 999, $3, 'b', 'c', '{}'::jsonb, '{}'::jsonb, NOW())`,
                [orgId, repoId, dupHead],
            );
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeTruthy();
        const errMsg = (thrown as { message?: string })?.message ?? '';
        expect(errMsg).toMatch(/unique|duplicate/i);
    });

    it('indexes IX_pr_decision_records_org_repo, _snapshot, UQ_repo_pr_head are present', async () => {
        const result = await client.query<{ indexname: string }>(
            `SELECT indexname FROM pg_indexes
             WHERE tablename = 'pr_decision_records'
               AND indexname IN (
                   'IX_pr_decision_records_org_repo',
                   'IX_pr_decision_records_snapshot',
                   'UQ_pr_decision_records_repo_pr_head'
               )`,
        );
        const names = result.rows.map((r) => r.indexname).sort();
        expect(names).toEqual([
            'IX_pr_decision_records_org_repo',
            'IX_pr_decision_records_snapshot',
            'UQ_pr_decision_records_repo_pr_head',
        ]);
    });
});

function randomSuffix(): string {
    return Math.floor(Math.random() * 1e12)
        .toString(16)
        .padStart(12, '0')
        .slice(0, 12);
}

function slug(): string {
    return Math.floor(Math.random() * 1e12)
        .toString(16)
        .padStart(8, '0')
        .slice(0, 8);
}
