import { randomUUID } from 'crypto';

import { Pool } from 'pg';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { RunTargetConflictError, type RunTarget } from '../domain/run-target';
import { PgRunTargetStore } from './pg-run-target.store';

// Same DDL as migration 2026103000000000 (uuid default aside), in a throwaway
// schema of the integration database.

// Opt-in: runs against the Postgres RUNTIME_IT_DATABASE_URL names (locally
// postgres://runtime:runtime@localhost:5442/kodus_runtime_it), and skips when
// none is named, as in the backend CI suite, which starts no such database.
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';
const schema = `it_targets_${Date.now()}`;

const target = (patch: Partial<RunTarget> = {}): RunTarget => ({
    runId: randomUUID(),
    attempt: 1,
    organizationId: 'org-a',
    teamId: 'team-a',
    repositoryId: '42',
    repositoryName: 'shop',
    repositoryFullName: 'acme/shop',
    platform: PlatformType.GITHUB,
    pullRequestNumber: 7,
    headSha: 'a'.repeat(40),
    ...patch,
});

(skip ? describe.skip : describe)('PgRunTargetStore (integration, real Postgres)', () => {
    let pool: Pool;
    let store: PgRunTargetStore;

    beforeAll(async () => {
        pool = new Pool({ connectionString: url, max: 2 });
        await pool.query(`CREATE SCHEMA ${schema}`);
        await pool.query(`
            CREATE TABLE ${schema}.runtime_run_targets (
                "uuid" uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "run_id" character varying(128) NOT NULL,
                "attempt" integer NOT NULL,
                "organization_id" character varying(128) NOT NULL,
                "team_id" character varying(128) NOT NULL,
                "repository_id" character varying(128) NOT NULL,
                "repository_name" character varying(256) NOT NULL,
                "repository_full_name" character varying(512),
                "platform" character varying(32) NOT NULL,
                "pr_number" integer NOT NULL,
                "head_sha" character varying(40) NOT NULL
            )`);
        await pool.query(`CREATE UNIQUE INDEX ON ${schema}.runtime_run_targets ("run_id")`);
        store = new PgRunTargetStore(pool, { table: `${schema}.runtime_run_targets` });
    });

    afterAll(async () => {
        await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await pool?.end();
    });

    it('records a target once, reads it back, and accepts the same target again', async () => {
        const t = target();
        await store.record(t);
        await store.record(t);
        expect(await store.get(t.runId)).toEqual(t);
        expect(await store.get(randomUUID())).toBeNull();
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${schema}.runtime_run_targets WHERE run_id = $1`, [t.runId]);
        expect(rows[0].n).toBe(1);
    });

    it('never lets a second record move a Run to another target', async () => {
        const t = target({ repositoryFullName: undefined });
        await store.record(t);
        await expect(store.record({ ...t, pullRequestNumber: 8 })).rejects.toBeInstanceOf(RunTargetConflictError);
        await expect(store.record({ ...t, repositoryFullName: 'other/shop' })).rejects.toBeInstanceOf(RunTargetConflictError);
        expect(await store.get(t.runId)).toEqual(t);
    });

    it('refuses a table name that is not an identifier', () => {
        expect(() => new PgRunTargetStore(pool, { table: 'x; DROP TABLE y' })).toThrow('invalid table name');
    });
});
