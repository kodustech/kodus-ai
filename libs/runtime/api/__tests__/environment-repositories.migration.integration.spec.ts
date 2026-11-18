import { randomUUID } from 'crypto';

import { Pool } from 'pg';
import { DataSource } from 'typeorm';

import { CreateRuntimeProductSettings2026103000000001 } from '@libs/core/infrastructure/database/typeorm/migrations/2026103000000001-CreateRuntimeProductSettings';
import { CreateRuntimeEnvironmentRepositories2026111100000000 } from '@libs/core/infrastructure/database/typeorm/migrations/2026111100000000-CreateRuntimeEnvironmentRepositories';
import { repositoryAliasOf } from '@libs/runtime/contracts/workspace';

// The membership migration against real Postgres: every environment that
// exists gets one primary row, with the alias repositoryAliasOf computes, and
// running it again changes nothing.

// Opt-in: runs against the Postgres RUNTIME_IT_DATABASE_URL names (locally
// postgres://runtime:runtime@localhost:5442/kodus_runtime_it), and skips when
// none is named, as in the backend CI suite, which starts no such database.
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';
const schema = `it_runtime_env_repos_${process.pid}_${Date.now()}`;

const NAMES = ['acme/shop', 'acme/Kodus-Service_Billing', 'group/sub/My Repo!!', 'billing', 'acme/--.Edge', 'acme/___', `acme/${'x'.repeat(80)}`];

(skip ? describe.skip : describe)('runtime_environment_repositories migration (integration, real Postgres)', () => {
    let admin: Pool;
    let source: DataSource;
    const migration = new CreateRuntimeEnvironmentRepositories2026111100000000();

    const up = async () => {
        const runner = source.createQueryRunner();
        try {
            await migration.up(runner);
        } finally {
            await runner.release();
        }
    };

    beforeAll(async () => {
        admin = new Pool({ connectionString: url, max: 1 });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        // The product database has uuid-ossp; a throwaway schema gets the same name over the built-in generator.
        await admin.query(`CREATE FUNCTION "${schema}".uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()'`);
        source = new DataSource({ type: 'postgres', url, extra: { options: `-c search_path=${schema}`, max: 2 }, entities: [], synchronize: false });
        await source.initialize();
        const runner = source.createQueryRunner();
        try {
            await new CreateRuntimeProductSettings2026103000000001().up(runner);
        } finally {
            await runner.release();
        }
        for (const [i, name] of NAMES.entries()) {
            await source.query(`INSERT INTO runtime_environments (organization_id, team_id, repository_id, repository_name) VALUES ($1, $2, $3, $4)`, [
                i % 2 ? 'org-b' : 'org-a',
                'team',
                randomUUID(),
                name,
            ]);
        }
    });

    afterAll(async () => {
        await source?.destroy();
        if (admin) {
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await admin.end();
        }
    });

    it('gives every environment one primary row with the alias of its short name, and runs again without a change', async () => {
        await up();
        await up();
        const rows: Array<{ environment_id: string; organization_id: string; repository_id: string; repository_name: string; full_name: string; role: string; alias: string; triggers: boolean; pair_branches: boolean }> =
            await source.query(`SELECT * FROM runtime_environment_repositories`);
        const environments: Array<{ uuid: string; organization_id: string; repository_id: string; repository_name: string }> = await source.query(`SELECT * FROM runtime_environments`);
        expect(rows).toHaveLength(environments.length);
        for (const env of environments) {
            const row = rows.find((r) => r.environment_id === env.uuid)!;
            expect(row).toMatchObject({
                organization_id: env.organization_id,
                repository_id: env.repository_id,
                repository_name: env.repository_name,
                full_name: env.repository_name,
                role: 'primary',
                alias: repositoryAliasOf(env.repository_name) ?? 'repo',
                triggers: true,
                pair_branches: false,
            });
        }
        expect(rows.map((r) => r.alias).sort()).toEqual(['billing', 'edge', 'kodus-service_billing', 'my-repo-', 'repo', 'shop', 'x'.repeat(63)]);
    });

    it('refuses a second primary, an alias twice in one environment, and an alias off the pattern', async () => {
        const [env]: Array<{ uuid: string; organization_id: string }> = await source.query(`SELECT uuid, organization_id FROM runtime_environments LIMIT 1`);
        const insert = (role: string, alias: string) =>
            source.query(
                `INSERT INTO runtime_environment_repositories (environment_id, organization_id, repository_id, repository_name, full_name, role, alias) VALUES ($1, $2, $3, 'acme/x', 'acme/x', $4, $5)`,
                [env.uuid, env.organization_id, randomUUID(), role, alias],
            );
        await expect(insert('primary', 'another')).rejects.toThrow(/UQ_runtime_environment_repositories_primary/);
        const [{ alias }] = await source.query(`SELECT alias FROM runtime_environment_repositories WHERE environment_id = $1`, [env.uuid]);
        await expect(insert('member', alias)).rejects.toThrow(/UQ_runtime_environment_repositories_env_alias/);
        await expect(insert('member', 'Bad Alias')).rejects.toThrow(/CHK_runtime_environment_repositories_alias/);
        await expect(insert('owner', 'fine')).rejects.toThrow(/CHK_runtime_environment_repositories_role/);
        await insert('member', 'fine');
    });
});
