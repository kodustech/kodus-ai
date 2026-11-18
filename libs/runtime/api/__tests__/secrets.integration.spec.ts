import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { request as httpsRequest } from 'https';
import { tmpdir } from 'os';
import { join } from 'path';

import { Pool } from 'pg';
import { DataSource } from 'typeorm';

import { CreateRuntimeSecrets2026111200000010 } from '@libs/core/infrastructure/database/typeorm/migrations/2026111200000010-CreateRuntimeSecrets';

import { RuntimeSecretVaultUnavailableError, type RuntimeSecretAuditRecord, type RuntimeSecretRecord } from '../domain/secrets';
import { loadOpenBaoSecretVaultConfig, OpenBaoSecretVault } from '../infrastructure/openbao-secret-vault.adapter';
import { TypeOrmSql } from '../infrastructure/typeorm-sql';
import { TypeOrmRuntimeSecretStore } from '../infrastructure/typeorm-runtime-secrets.store';

// Opt-in, against real infrastructure, skipped when none is named (as in the
// backend CI suite):
// - RUNTIME_IT_DATABASE_URL: a Postgres for the metadata store (a throwaway schema);
// - RUNTIME_IT_OPENBAO_ADDR (+ _CA_FILE, _ROLE_ID_FILE, _SECRET_ID_FILE of the
//   API's AppRole): an OpenBao started from docker/openbao (scripts/runtime/dev-openbao.sh).
// Synthetic values only.

const VALUE = 'npm_synthetic_value_7f3a91c2d4';
const ORG = `org-it-${process.pid}`;

const pgUrl = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const baoEnv = {
    RUNTIME_OPENBAO_ADDR: process.env.RUNTIME_IT_OPENBAO_ADDR,
    RUNTIME_OPENBAO_CA_FILE: process.env.RUNTIME_IT_OPENBAO_CA_FILE,
    RUNTIME_OPENBAO_ROLE_ID_FILE: process.env.RUNTIME_IT_OPENBAO_ROLE_ID_FILE,
    RUNTIME_OPENBAO_SECRET_ID_FILE: process.env.RUNTIME_IT_OPENBAO_SECRET_ID_FILE,
};
const skipAll = process.env.SKIP_INTEGRATION === 'true';

const record = (secretId: string, org = ORG): RuntimeSecretRecord => ({
    organizationId: org,
    secretId,
    name: secretId.toUpperCase(),
    hosts: ['npm.corp.example'],
    createdBy: { userId: 'u-1' },
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedBy: { userId: 'u-1' },
    updatedAt: '2026-11-12T10:00:00.000Z',
    valueSetAt: '2026-11-12T10:00:00.000Z',
});
const audit = (r: RuntimeSecretRecord, action: RuntimeSecretAuditRecord['action']): RuntimeSecretAuditRecord => ({
    auditId: crypto.randomUUID(),
    organizationId: r.organizationId,
    secretId: r.secretId,
    name: r.name,
    action,
    hosts: r.hosts,
    valueReplaced: action !== 'deleted',
    actor: { userId: 'u-1' },
    at: new Date().toISOString(),
});

(skipAll || !pgUrl ? describe.skip : describe)('Runtime secret metadata store (integration, real Postgres)', () => {
    const schema = `it_runtime_secrets_${process.pid}_${Date.now()}`;
    let admin: Pool;
    let source: DataSource;
    let store: TypeOrmRuntimeSecretStore;

    beforeAll(async () => {
        admin = new Pool({ connectionString: pgUrl, max: 1 });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        source = new DataSource({ type: 'postgres', url: pgUrl, extra: { options: `-c search_path=${schema}`, max: 2 }, entities: [], synchronize: false });
        await source.initialize();
        const runner = source.createQueryRunner();
        try {
            await new CreateRuntimeSecrets2026111200000010().up(runner);
        } finally {
            await runner.release();
        }
        store = new TypeOrmRuntimeSecretStore(new TypeOrmSql(source));
    });

    afterAll(async () => {
        await source?.destroy();
        if (admin) {
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await admin.end();
        }
    });

    it('keeps no row and no audit when the vault call fails inside the write', async () => {
        const r = record('npm_failed');
        await expect(store.create(r, audit(r, 'created'), async () => Promise.reject(new RuntimeSecretVaultUnavailableError('synthetic')))).rejects.toBeInstanceOf(
            RuntimeSecretVaultUnavailableError,
        );
        expect(await store.list(ORG)).toEqual([]);
        expect(await store.listAudit(ORG, 10)).toEqual([]);
    });

    it('refuses a second secret of the same name without calling the vault', async () => {
        const r = record('npm_token');
        await store.create(r, audit(r, 'created'), async () => undefined);
        const effect = jest.fn(async () => undefined);
        await expect(store.create(r, audit(r, 'created'), effect)).resolves.toBeNull();
        expect(effect).not.toHaveBeenCalled();
    });

    it("never reaches another org's secret of the same name", async () => {
        const mine = record('shared_name');
        const theirs = record('shared_name', `${ORG}-other`);
        await store.create(mine, audit(mine, 'created'), async () => undefined);
        await store.create(theirs, audit(theirs, 'created'), async () => undefined);
        const effect = jest.fn(async () => undefined);
        await expect(store.delete(ORG, 'shared_name', (c) => audit(c, 'deleted'), effect)).resolves.toBe(true);
        expect((await store.list(`${ORG}-other`)).map((s) => s.secretId)).toEqual(['shared_name']);
        expect((await store.listAudit(`${ORG}-other`, 10)).map((a) => a.action)).toEqual(['created']);
    });

    it('rolls a host change back when the vault refuses it', async () => {
        const r = record('npm_rollback');
        await store.create(r, audit(r, 'created'), async () => undefined);
        await expect(
            store.update(
                ORG,
                'npm_rollback',
                (c) => {
                    const next = { ...c, hosts: ['npm2.corp.example'] };
                    return { next, audit: audit(next, 'updated') };
                },
                async () => Promise.reject(new RuntimeSecretVaultUnavailableError('synthetic')),
            ),
        ).rejects.toBeInstanceOf(RuntimeSecretVaultUnavailableError);
        expect((await store.list(ORG)).find((s) => s.secretId === 'npm_rollback')?.hosts).toEqual(['npm.corp.example']);
    });
});

/** A raw GET with the API's own token: what the API could read if its policy let it. */
function getWithToken(address: string, ca: string | undefined, token: string, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = httpsRequest(new URL(path, address), { method: 'GET', ca, headers: { 'X-Vault-Token': token } }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

(skipAll || !baoEnv.RUNTIME_OPENBAO_ADDR ? describe.skip : describe)('OpenBao secret vault adapter (integration, real OpenBao)', () => {
    const config = () => loadOpenBaoSecretVaultConfig(baoEnv as NodeJS.ProcessEnv)!;

    it("writes, patches and deletes a secret, and the API's own token cannot read it back", async () => {
        const vault = new OpenBaoSecretVault(config());
        await vault.write(ORG, 'npm_token', { value: VALUE, hosts: ['npm.corp.example'] });
        await vault.setHosts(ORG, 'npm_token', ['npm2.corp.example']);
        const token: string = (vault as any).token.value;
        for (const path of [`/v1/runtime-kv/data/orgs/${ORG}/secrets/npm_token`, `/v1/runtime-kv/metadata/orgs/${ORG}/secrets/npm_token`]) {
            const res = await getWithToken(config().address, config().ca, token, path);
            expect(res.status).toBe(403);
            expect(res.body).not.toContain(VALUE);
        }
        await vault.delete(ORG, 'npm_token');
        await expect(vault.delete(ORG, 'npm_token')).resolves.toBeUndefined();
    });

    it('fails closed with a fixed error when its credential file is readable by others', async () => {
        const cfg = config();
        const dir = mkdtempSync(join(tmpdir(), 'bao-it-'));
        const loose = join(dir, 'role-id');
        writeFileSync(loose, readFileSync(cfg.roleIdFile), { mode: 0o644 });
        try {
            await expect(new OpenBaoSecretVault({ ...cfg, roleIdFile: loose }).write(ORG, 'npm_token', { value: VALUE, hosts: ['npm.corp.example'] })).rejects.toBeInstanceOf(
                RuntimeSecretVaultUnavailableError,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
