import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

import { Pool } from 'pg';
import { DataSource } from 'typeorm';

import { CreateRuntimeSecrets2026111200000010 } from '@libs/core/infrastructure/database/typeorm/migrations/2026111200000010-CreateRuntimeSecrets';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import { PgOrgSecretRefs } from '../../../../apps/runtime/src/hub/claims/org-secret-refs';
import { CreateRuntimeSecretUseCase, DeleteRuntimeSecretUseCase } from '../application/use-cases/secrets.use-cases';
import { loadOpenBaoSecretVaultConfig, OpenBaoSecretVault } from '../infrastructure/openbao-secret-vault.adapter';
import { TypeOrmRuntimeSecretStore } from '../infrastructure/typeorm-runtime-secrets.store';
import { TypeOrmSql } from '../infrastructure/typeorm-sql';
import { clock, config, user } from './fixtures';

// An org secret from the API to the cell (docs/runtime/sandbox.md "Secrets:
// OpenBao"), across the three processes it crosses:
//   1. the API's use case writes the value to OpenBao (the API's AppRole) and
//      the metadata to the product Postgres (a throwaway database, the real
//      migration);
//   2. the hub's reader takes the references as the role the grants script
//      makes (id, name, hosts; nothing else of the table);
//   3. the Go cell half (apps/runtime-cell/internal/agent/org_secrets_smoke_test.go)
//      takes those references in a sandbox.acquire, gives the sandbox a
//      placeholder, and a command there reaches the secret's host, which
//      receives the value the API wrote, read by the injector's AppRole.
// Opt-in: RUNTIME_IT_DATABASE_URL (a role that may create a database and a
// role), RUNTIME_IT_OPENBAO_ADDR (+ _CA_FILE, _ROLE_ID_FILE, _SECRET_ID_FILE
// of the API's AppRole, beside the injector's, as scripts/runtime/dev-openbao.sh
// writes them), go, docker and curl. Synthetic values only.

const ROOT = resolve(__dirname, '../../../..');
const pgUrl = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const baoEnv = {
    RUNTIME_OPENBAO_ADDR: process.env.RUNTIME_IT_OPENBAO_ADDR,
    RUNTIME_OPENBAO_CA_FILE: process.env.RUNTIME_IT_OPENBAO_CA_FILE,
    RUNTIME_OPENBAO_ROLE_ID_FILE: process.env.RUNTIME_IT_OPENBAO_ROLE_ID_FILE,
    RUNTIME_OPENBAO_SECRET_ID_FILE: process.env.RUNTIME_IT_OPENBAO_SECRET_ID_FILE,
};
const hasGo = spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0;
const enabled = process.env.SKIP_INTEGRATION !== 'true' && !!pgUrl && !!baoEnv.RUNTIME_OPENBAO_ADDR && hasGo;

(enabled ? describe : describe.skip)('An org secret from the API to the cell (integration)', () => {
    jest.setTimeout(300_000);
    const db = `it_runtime_secrets_${process.pid}_${Date.now().toString(36)}`;
    const readerPassword = randomBytes(16).toString('hex');
    const owner = user(Role.OWNER, { org: `org-it-${randomBytes(4).toString('hex')}` });
    const org = owner.organization.uuid;
    const VALUE = `npm_synthetic_value_${randomBytes(6).toString('hex')}`;
    const dbUrl = (u: string, user?: { name: string; password: string }) => {
        const url = new URL(u);
        url.pathname = `/${db}`;
        if (user) {
            url.username = user.name;
            url.password = user.password;
        }
        return url.toString();
    };
    let admin: Pool;
    let source: DataSource;
    let reader: Pool;

    beforeAll(async () => {
        admin = new Pool({ connectionString: pgUrl, max: 1 });
        await admin.query(`CREATE DATABASE "${db}"`);
        source = new DataSource({ type: 'postgres', url: dbUrl(pgUrl), entities: [], synchronize: false, extra: { max: 2 } });
        await source.initialize();
        const runner = source.createQueryRunner();
        try {
            await new CreateRuntimeSecrets2026111200000010().up(runner);
        } finally {
            await runner.release();
        }
        // The hub's role, as dev-runtime-users.sh makes it, and its grants.
        await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kodus_runtime_secrets_reader') THEN CREATE ROLE kodus_runtime_secrets_reader LOGIN; END IF; END $$`);
        await admin.query(`ALTER ROLE kodus_runtime_secrets_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${readerPassword}'`);
        await admin.query(`GRANT CONNECT ON DATABASE "${db}" TO kodus_runtime_secrets_reader`);
        await source.query(readFileSync(join(ROOT, 'scripts/runtime/runtime-secrets-reader-grants.sql'), 'utf8'));
        reader = new Pool({ connectionString: dbUrl(pgUrl, { name: 'kodus_runtime_secrets_reader', password: readerPassword }), max: 1 });
    });

    afterAll(async () => {
        await reader?.end().catch(() => undefined);
        await source?.destroy().catch(() => undefined);
        if (admin) {
            await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => undefined);
            await admin.end();
        }
    });

    it("reaches its host as the value from a claim, while the machine sees only the placeholder", async () => {
        const store = new TypeOrmRuntimeSecretStore(new TypeOrmSql(source));
        const vault = new OpenBaoSecretVault(loadOpenBaoSecretVaultConfig(baoEnv as NodeJS.ProcessEnv)!);
        const args = [store, vault, config(), clock] as const;
        await new CreateRuntimeSecretUseCase(...args).execute({ user: owner as any, body: { name: 'NPM_TOKEN', hosts: ['npm.registry.test'], value: VALUE } });
        try {
            // The hub's view: the reference only, and nothing else of the row.
            const refs = await new PgOrgSecretRefs(reader).secretsOf(org);
            expect(refs).toEqual([{ id: 'npm_token', name: 'NPM_TOKEN', hosts: ['npm.registry.test'] }]);
            await expect(reader.query('SELECT created_by FROM runtime_secrets')).rejects.toThrow(/permission denied/);
            await expect(reader.query('SELECT * FROM runtime_secret_audit')).rejects.toThrow(/permission denied/);

            const cell = spawnSync('go', ['test', '-tags', 'dockersmoke', '-count=1', '-run', 'TestAnOrgSecretReachesItsHost', '-v', './internal/agent/'], {
                cwd: join(ROOT, 'apps/runtime-cell'),
                encoding: 'utf8',
                timeout: 240_000,
                env: {
                    ...process.env,
                    KGR_OPENBAO_ADDR: baoEnv.RUNTIME_OPENBAO_ADDR,
                    KGR_OPENBAO_CA_FILE: baoEnv.RUNTIME_OPENBAO_CA_FILE,
                    // dev-openbao.sh writes both AppRoles' files in one directory.
                    KGR_OPENBAO_DIR: dirname(baoEnv.RUNTIME_OPENBAO_ROLE_ID_FILE!),
                    KGR_E2E_ORG: org,
                    KGR_E2E_SECRET_REFS: JSON.stringify(refs),
                    KGR_E2E_SECRET_VALUE: VALUE,
                },
            });
            const out = `${cell.stdout}\n${cell.stderr}`;
            if (cell.status !== 0) throw new Error(`the cell half failed:\n${out.split('\n').filter((l) => !l.startsWith('20')).slice(-30).join('\n')}`);
            expect(out).toContain('--- PASS: TestAnOrgSecretReachesItsHostAsTheValueWhileTheMachineHoldsThePlaceholder');
        } finally {
            await new DeleteRuntimeSecretUseCase(...args).execute({ user: owner as any, secretId: 'npm_token' });
        }
    });
});
