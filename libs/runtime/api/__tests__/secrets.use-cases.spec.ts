import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import {
    CreateRuntimeSecretUseCase,
    DeleteRuntimeSecretUseCase,
    ListRuntimeSecretAuditUseCase,
    ListRuntimeSecretsUseCase,
    UpdateRuntimeSecretUseCase,
} from '../application/use-cases/secrets.use-cases';
import {
    RuntimeSecretVaultUnavailableError,
    type RuntimeSecretAuditRecord,
    type RuntimeSecretRecord,
    type RuntimeSecretStore,
    type RuntimeSecretVaultPort,
} from '../domain/secrets';
import { clock, config, OTHER_ORG, user } from './fixtures';

// Synthetic values only.
const VALUE = 'npm_synthetic_value_7f3a91c2d4';
const owner = user(Role.OWNER);
const otherOrgOwner = user(Role.OWNER, { org: OTHER_ORG, uuid: 'other-owner' });

/** The store's contract: the vault call runs inside the write; when it throws, nothing is kept. */
class MemorySecretStore implements RuntimeSecretStore {
    rows = new Map<string, RuntimeSecretRecord>();
    audit: RuntimeSecretAuditRecord[] = [];
    private key = (org: string, id: string) => `${org}|${id}`;

    async list(org: string) {
        return [...this.rows.values()].filter((r) => r.organizationId === org);
    }
    async count(org: string) {
        return (await this.list(org)).length;
    }
    async create(record: RuntimeSecretRecord, audit: RuntimeSecretAuditRecord, effect: () => Promise<void>) {
        if (this.rows.has(this.key(record.organizationId, record.secretId))) return null;
        await effect();
        this.rows.set(this.key(record.organizationId, record.secretId), record);
        this.audit.push(audit);
        return record;
    }
    async update(org: string, id: string, change: Parameters<RuntimeSecretStore['update']>[2], effect: Parameters<RuntimeSecretStore['update']>[3]) {
        const current = this.rows.get(this.key(org, id));
        if (!current) return null;
        const { next, audit } = change(current);
        await effect(current, next);
        this.rows.set(this.key(org, id), next);
        this.audit.push(audit);
        return next;
    }
    async delete(org: string, id: string, audit: (c: RuntimeSecretRecord) => RuntimeSecretAuditRecord, effect: () => Promise<void>) {
        const current = this.rows.get(this.key(org, id));
        if (!current) return false;
        await effect();
        this.rows.delete(this.key(org, id));
        this.audit.push(audit(current));
        return true;
    }
    async listAudit(org: string, limit: number) {
        return this.audit.filter((a) => a.organizationId === org).reverse().slice(0, limit);
    }
}

class FakeVault implements RuntimeSecretVaultPort {
    configured = true;
    values = new Map<string, { value?: string; hosts: string[] }>();
    calls: string[] = [];
    failNext = false;
    private check(op: string) {
        this.calls.push(op);
        if (this.failNext) {
            this.failNext = false;
            throw new RuntimeSecretVaultUnavailableError('synthetic outage');
        }
    }
    async write(org: string, id: string, s: { value: string; hosts: string[] }) {
        this.check('write');
        this.values.set(`${org}|${id}`, { ...s });
    }
    async setHosts(org: string, id: string, hosts: string[]) {
        this.check('setHosts');
        const cur = this.values.get(`${org}|${id}`)!;
        this.values.set(`${org}|${id}`, { ...cur, hosts });
    }
    async delete(org: string, id: string) {
        this.check('delete');
        this.values.delete(`${org}|${id}`);
    }
}

function setup(vault = new FakeVault(), cfg = config()) {
    const store = new MemorySecretStore();
    const args = [store, vault, cfg, clock] as const;
    return {
        store,
        vault,
        list: new ListRuntimeSecretsUseCase(...args),
        create: new CreateRuntimeSecretUseCase(...args),
        update: new UpdateRuntimeSecretUseCase(...args),
        remove: new DeleteRuntimeSecretUseCase(...args),
        audit: new ListRuntimeSecretAuditUseCase(...args),
    };
}

const createNpm = (s: ReturnType<typeof setup>, u = owner) => s.create.execute({ user: u, body: { name: 'NPM_TOKEN', hosts: ['NPM.Corp.Example'], value: VALUE } });

describe('Runtime secrets', () => {
    it('sends a new value to the vault only: no answer, list or audit carries it', async () => {
        const s = setup();
        const created = await createNpm(s);
        expect(created).toMatchObject({ secretId: 'npm_token', name: 'NPM_TOKEN', hosts: ['npm.corp.example'] });
        expect(s.vault.values.get(`${owner.organization!.uuid}|npm_token`)).toEqual({ value: VALUE, hosts: ['npm.corp.example'] });
        const seen = JSON.stringify([created, await s.list.execute({ user: owner }), await s.audit.execute({ user: owner }), [...s.store.rows.values()]]);
        expect(seen).not.toContain(VALUE);
    });

    it.each([
        ['a wildcard', ['*.corp.example']],
        ['an IP address', ['10.0.0.5']],
        ['a host on the Kodus denylist', ['pastebin.com']],
        ['no host', []],
    ])('refuses %s before anything is written', async (_, hosts) => {
        const s = setup();
        await expect(s.create.execute({ user: owner, body: { name: 'NPM_TOKEN', hosts, value: VALUE } })).rejects.toBeInstanceOf(BadRequestException);
        expect(s.vault.calls).toEqual([]);
        expect(s.store.rows.size).toBe(0);
    });

    it.each([
        ['lower case', 'npm_token'],
        ['a reserved name', 'NODE_OPTIONS'],
        ['a Kodus prefix', 'KODUS_TOKEN'],
        ['a trust variable the cell sets', 'REQUESTS_CA_BUNDLE'],
        ['a trust variable the cell sets', 'CURL_CA_BUNDLE'],
        ['a trust variable the cell sets', 'GIT_SSL_CAINFO'],
        ['a trust variable the cell sets', 'SSL_CERT_FILE'],
        ['a variable the cell drops from every machine', 'GIT_TERMINAL_PROMPT'],
    ])('refuses a name in %s', async (_, name) => {
        const s = setup();
        await expect(s.create.execute({ user: owner, body: { name, hosts: ['npm.corp.example'], value: VALUE } })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a value that would break a header, without repeating it', async () => {
        const s = setup();
        const bad = `${VALUE}\r\nX-Injected: 1`;
        const err = await s.create.execute({ user: owner, body: { name: 'NPM_TOKEN', hosts: ['npm.corp.example'], value: bad } }).catch((e) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect(JSON.stringify(err.getResponse())).not.toContain(VALUE);
    });

    it('keeps nothing when the vault fails, and says the store is unavailable', async () => {
        const s = setup();
        s.vault.failNext = true;
        await expect(createNpm(s)).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(s.store.rows.size).toBe(0);
        expect(s.store.audit).toEqual([]);
    });

    it('answers 503 and writes nothing when no store is configured', async () => {
        const vault = new FakeVault();
        vault.configured = false;
        const s = setup(vault);
        await expect(createNpm(s)).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(vault.calls).toEqual([]);
        await expect(s.list.execute({ user: owner })).resolves.toEqual({ configured: false, secrets: [] });
    });

    it('refuses a second secret of the same name without touching the first value', async () => {
        const s = setup();
        await createNpm(s);
        await expect(s.create.execute({ user: owner, body: { name: 'NPM_TOKEN', hosts: ['npm.corp.example'], value: 'npm_synthetic_other_1234' } })).rejects.toBeInstanceOf(ConflictException);
        expect(s.vault.values.get(`${owner.organization!.uuid}|npm_token`)?.value).toBe(VALUE);
    });

    it('changes the hosts without sending a value, and a new value as a new write', async () => {
        const s = setup();
        await createNpm(s);
        s.vault.calls = [];
        await expect(s.update.execute({ user: owner, secretId: 'npm_token', body: { hosts: ['npm2.corp.example'] } })).resolves.toMatchObject({ hosts: ['npm2.corp.example'] });
        expect(s.vault.calls).toEqual(['setHosts']);
        await s.update.execute({ user: owner, secretId: 'npm_token', body: { value: 'npm_synthetic_rotated_99' } });
        expect(s.vault.values.get(`${owner.organization!.uuid}|npm_token`)).toEqual({ value: 'npm_synthetic_rotated_99', hosts: ['npm2.corp.example'] });
        const { entries } = await s.audit.execute({ user: owner });
        expect(entries.map((e) => [e.action, e.valueReplaced])).toEqual([
            ['updated', true],
            ['updated', false],
            ['created', true],
        ]);
    });

    it('deletes the secret from the vault and records who did it', async () => {
        const s = setup();
        await createNpm(s);
        await s.remove.execute({ user: owner, secretId: 'npm_token' });
        expect(s.vault.values.size).toBe(0);
        const { entries } = await s.audit.execute({ user: owner });
        expect(entries[0]).toMatchObject({ action: 'deleted', name: 'NPM_TOKEN', actor: { userId: owner.uuid } });
    });

    it("answers 404 for another org's secret and leaves it alone", async () => {
        const s = setup();
        await createNpm(s);
        await expect(s.update.execute({ user: otherOrgOwner, secretId: 'npm_token', body: { value: 'npm_synthetic_takeover_1' } })).rejects.toBeInstanceOf(NotFoundException);
        await expect(s.remove.execute({ user: otherOrgOwner, secretId: 'npm_token' })).rejects.toBeInstanceOf(NotFoundException);
        expect(s.vault.values.get(`${owner.organization!.uuid}|npm_token`)?.value).toBe(VALUE);
        await expect(s.list.execute({ user: otherOrgOwner })).resolves.toMatchObject({ secrets: [] });
    });
});
