import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { Pool } from 'pg';
import { DataSource } from 'typeorm';

import { isolatedDatabase } from '../../../../apps/runtime/src/testing/isolated-database';
import { orgDayCounterKey, pullRequestCounterKey, runCounterKey } from '../infrastructure/typeorm-llm-budget.store';
import { RUNTIME_PRODUCT_ORGANIZATION_TABLES, TypeOrmRuntimeOrganizationPurgeStore } from '../infrastructure/typeorm-runtime-organization-purge.store';
import { RUNTIME_SECRET_AUDIT_TABLE, RUNTIME_SECRETS_TABLE } from '../infrastructure/typeorm-runtime-secrets.store';
import { TypeOrmSql } from '../infrastructure/typeorm-sql';

// The product-side purge of one organization against a real Postgres, in a schema made by the product's own Runtime
// migrations (every migration of the product named for the Runtime, in order). Opt-in: RUNTIME_IT_DATABASE_URL.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'organization_purge_product');
const skip = !database.url || process.env.SKIP_INTEGRATION === 'true';
const schema = `runtime_purge_it_${process.pid}`;
// Columns a CHECK constraint pins to a value the generic seed cannot guess.
const PINNED: Record<string, Record<string, unknown>> = {
    runtime_secrets: { secret_id: 'secret_one', name: 'secret_one' },
    runtime_secret_audit: { action: 'created' },
    runtime_environment_repositories: { role: 'primary', alias: 'app' },
    runtime_finding_feedback: { value: 'up' },
    runtime_reconciled_heads: { state: 'decided', attempts: 1 },
};
const MIGRATIONS = path.resolve(__dirname, '../../../core/infrastructure/database/typeorm/migrations');

(skip ? describe.skip : describe)('Runtime organization purge in the product Postgres (integration, real Postgres)', () => {
    let admin: Pool;
    let source: DataSource;
    let sql: TypeOrmSql;
    let store: TypeOrmRuntimeOrganizationPurgeStore;
    const columns = new Map<string, Array<{ name: string; type: string; nullable: boolean; hasDefault: boolean }>>();

    beforeAll(async () => {
        await database.create();
        admin = new Pool({ connectionString: database.url, max: 1 });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        // The product database has uuid-ossp; a throwaway schema gets the same name over the built-in generator.
        await admin.query(`CREATE FUNCTION "${schema}".uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()'`);
        source = new DataSource({ type: 'postgres', url: database.url, entities: [], synchronize: false, extra: { options: `-c search_path=${schema}`, max: 4 } });
        await source.initialize();
        sql = new TypeOrmSql(source);
        store = new TypeOrmRuntimeOrganizationPurgeStore(sql);
        const runner = source.createQueryRunner();
        try {
            for (const file of fs.readdirSync(MIGRATIONS).filter((f) => /runtime/i.test(f) && f.endsWith('.ts')).sort()) {
                const exported = Object.values(require(path.join(MIGRATIONS, file))) as Array<new () => { up(r: unknown): Promise<void> }>;
                await new exported[0]().up(runner);
            }
        } finally {
            await runner.release();
        }
        const { rows } = await admin.query(
            `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
              WHERE table_schema = $1 AND table_name LIKE 'runtime\\_%' ORDER BY table_name, ordinal_position`,
            [schema],
        );
        for (const r of rows) {
            const list = columns.get(r.table_name) ?? [];
            list.push({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES', hasDefault: r.column_default !== null });
            columns.set(r.table_name, list);
        }
    });
    afterAll(async () => {
        await source?.destroy();
        await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await admin?.end();
        await database.drop();
    });

    /** One row of `table` for `tag`: the org column set, every other required column a value derived from its name and the tag. */
    async function seed(table: string, tag: string, pinned: Record<string, unknown> = {}) {
        const values: Record<string, unknown> = {};
        for (const c of columns.get(table)!) {
            if (c.name === 'organization_id') values[c.name] = `org-${tag}`;
            else if (c.name in pinned) values[c.name] = pinned[c.name];
            else if (c.name in (PINNED[table] ?? {})) values[c.name] = PINNED[table][c.name];
            else if (c.nullable || c.hasDefault) continue;
            else if (c.type === 'integer' || c.type === 'bigint' || c.type === 'smallint') values[c.name] = 1;
            else if (c.type === 'boolean') values[c.name] = false;
            else if (c.type.startsWith('timestamp') || c.type === 'date') values[c.name] = new Date();
            else if (c.type === 'jsonb' || c.type === 'json') values[c.name] = '{}';
            else if (c.type === 'ARRAY') values[c.name] = '{}';
            else if (c.type === 'uuid') values[c.name] = randomUUID();
            else values[c.name] = `${c.name}-${tag}`;
        }
        const names = Object.keys(values);
        await admin.query(`INSERT INTO "${schema}".${table} (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(values));
    }
    const count = async (table: string, where = 'true', params: unknown[] = []) => Number((await admin.query(`SELECT count(*)::int AS n FROM "${schema}".${table} WHERE ${where}`, params)).rows[0].n);

    const allTables = [...RUNTIME_PRODUCT_ORGANIZATION_TABLES, RUNTIME_SECRETS_TABLE, RUNTIME_SECRET_AUDIT_TABLE];

    it('names every runtime table of the product that carries an organization, so a new one cannot be forgotten', () => {
        const withOrg = [...columns.entries()].filter(([, cols]) => cols.some((c) => c.name === 'organization_id')).map(([t]) => t);
        expect([...allTables].sort()).toEqual(withOrg.sort());
    });

    it("removes every product row of one organization, its budget counters and its secrets' metadata, and nothing of another", async () => {
        const day = new Date('2026-11-20T00:00:00Z');
        for (const tag of ['a', 'b']) {
            const environmentId = randomUUID();
            const receiptId = randomUUID();
            // The environment first, and the submission before its message keys: rows that name them (foreign keys with a cascade).
            await seed('runtime_environments', tag, { uuid: environmentId });
            for (const table of allTables.filter((t) => t !== 'runtime_environments')) {
                await seed(table, tag, table === 'runtime_environment_repositories' ? { environment_id: environmentId } : table.startsWith('runtime_external_') ? { receipt_id: receiptId } : {});
            }
            // The counters keyed, not columned: the org's Run, its PR and its day.
            await admin.query(`INSERT INTO "${schema}".runtime_llm_budget (key, tokens) VALUES ($1, 1), ($2, 1), ($3, 1)`, [runCounterKey(`run_id-${tag}`), pullRequestCounterKey({ organizationId: `org-${tag}`, repositoryId: 'r', prNumber: 1 }), orgDayCounterKey(`org-${tag}`, day)]);
        }
        // An org whose id merely starts with another's: its counters are not the other's.
        await admin.query(`INSERT INTO "${schema}".runtime_llm_budget (key, tokens) VALUES ($1, 1)`, [orgDayCounterKey('org-ab', day)]);
        expect(await store.secretIds('org-a')).toEqual(['secret_one']);

        const removed = await store.purgeOrganization('org-a');

        for (const table of allTables) {
            expect([table, await count(table, 'organization_id = $1', ['org-a']), await count(table, 'organization_id = $1', ['org-b'])]).toEqual([table, 0, 1]);
        }
        expect(await count('runtime_llm_budget', `key LIKE '%org-a/%' OR key = 'run/run_id-a'`)).toBe(0);
        expect(await count('runtime_llm_budget', `key LIKE '%org-b/%' OR key = 'run/run_id-b'`)).toBe(3);
        expect(await count('runtime_llm_budget', `key = $1`, [orgDayCounterKey('org-ab', day)])).toBe(1);
        // A second run finds nothing, and the summary names tables and counts only.
        expect(removed.runtime_environments).toBe(1);
        expect(removed.runtime_llm_budget).toBe(3);
        expect(await store.purgeOrganization('org-a')).toEqual({});
        expect(await store.secretIds('org-a')).toEqual([]);
    });

    it('keeps the metadata and the audit of a secret whose value is still in the secret store', async () => {
        await seed(RUNTIME_SECRETS_TABLE, 'c', { secret_id: 'first', name: 'first' });
        await admin.query(`INSERT INTO "${schema}".${RUNTIME_SECRETS_TABLE} (organization_id, secret_id, name, hosts, created_by, created_at, updated_by, updated_at, value_set_at) VALUES ('org-c', 'second', 'second', '[]', '{}', now(), '{}', now(), now())`);
        await seed(RUNTIME_SECRET_AUDIT_TABLE, 'c');

        await store.purgeOrganization('org-c', { keepSecretIds: ['second'] });

        expect(await store.secretIds('org-c')).toEqual(['second']);
        expect(await count(RUNTIME_SECRET_AUDIT_TABLE, `organization_id = 'org-c'`)).toBe(1);

        await store.purgeOrganization('org-c');
        expect(await store.secretIds('org-c')).toEqual([]);
        expect(await count(RUNTIME_SECRET_AUDIT_TABLE, `organization_id = 'org-c'`)).toBe(0);
    });
});
