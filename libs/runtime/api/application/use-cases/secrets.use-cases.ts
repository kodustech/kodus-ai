import { randomUUID } from 'crypto';

import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
    UnprocessableEntityException,
} from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { DEFAULT_EGRESS_DENYLIST } from '../../domain/egress';
import { RUNTIME_API_CONFIG, RUNTIME_CLOCK, type Clock, type RuntimeApiConfig } from '../../domain/ports';
import {
    InvalidRuntimeSecretError,
    MAX_SECRETS_PER_ORG,
    normalizeSecretHosts,
    normalizeSecretName,
    RUNTIME_SECRET_STORE,
    RUNTIME_SECRET_VAULT,
    RuntimeSecretVaultUnavailableError,
    secretIdOf,
    secretView,
    validateSecretValue,
    type RuntimeSecretActor,
    type RuntimeSecretAuditRecord,
    type RuntimeSecretRecord,
    type RuntimeSecretStore,
    type RuntimeSecretVaultPort,
} from '../../domain/secrets';

// Org secrets of the Runtime (docs/runtime/sandbox.md "Secrets: OpenBao").
// The org admin manages them (the controller checks the role); the value is
// write-only: it goes to OpenBao and is never returned, logged or kept here.

/** The ids OpenBao paths are built from (the injector's vaultID on the cell). */
const ORG_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;

type Caller = { user: Partial<IUser> };

function organizationOf(user: Partial<IUser>): string {
    const organizationId = user?.organization?.uuid;
    if (!organizationId || !ORG_ID.test(organizationId)) throw new NotFoundException('Organization not found');
    return organizationId;
}

function actorOf(user: Partial<IUser>): RuntimeSecretActor {
    return { userId: user.uuid!, ...(user.email ? { email: user.email } : {}) };
}

function secretIdFrom(raw: string): string {
    if (typeof raw !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(raw)) throw new NotFoundException('Secret not found');
    return raw;
}

/** Bad input is a 400 whose message never carries the value; a vault failure is a 503. */
async function mapped<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        if (e instanceof InvalidRuntimeSecretError) throw new BadRequestException(e.message);
        if (e instanceof RuntimeSecretVaultUnavailableError) throw new ServiceUnavailableException('The secret store is unavailable; nothing was changed');
        throw e;
    }
}

@Injectable()
class SecretsUseCase {
    constructor(
        @Inject(RUNTIME_SECRET_STORE) protected readonly store: RuntimeSecretStore,
        @Inject(RUNTIME_SECRET_VAULT) protected readonly vault: RuntimeSecretVaultPort,
        @Inject(RUNTIME_API_CONFIG) protected readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK) protected readonly now: Clock,
    ) {}

    protected ensureVault() {
        if (!this.vault.configured) {
            throw new ServiceUnavailableException('No secret store is configured for this Kodus installation (RUNTIME_OPENBAO_ADDR)');
        }
    }

    protected hosts(raw: unknown): string[] {
        return normalizeSecretHosts(raw, [...DEFAULT_EGRESS_DENYLIST, ...(this.config.egressDenylist ?? [])]);
    }

    protected audit(record: RuntimeSecretRecord, action: RuntimeSecretAuditRecord['action'], valueReplaced: boolean, actor: RuntimeSecretActor, at: string): RuntimeSecretAuditRecord {
        return {
            auditId: randomUUID(),
            organizationId: record.organizationId,
            secretId: record.secretId,
            name: record.name,
            action,
            hosts: record.hosts,
            valueReplaced,
            actor,
            at,
        };
    }
}

/** GET /runtime/secrets — the org's secrets, metadata only, and whether a store is configured. */
@Injectable()
export class ListRuntimeSecretsUseCase extends SecretsUseCase {
    async execute({ user }: Caller) {
        const organizationId = organizationOf(user);
        const secrets = await this.store.list(organizationId);
        return { configured: this.vault.configured, secrets: secrets.map(secretView) };
    }
}

/** POST /runtime/secrets — a new secret: name, hosts and the value, which goes to the store only. */
@Injectable()
export class CreateRuntimeSecretUseCase extends SecretsUseCase {
    async execute({ user, body }: Caller & { body: { name?: unknown; hosts?: unknown; value?: unknown } }) {
        const organizationId = organizationOf(user);
        return mapped(async () => {
            const name = normalizeSecretName(body?.name);
            const hosts = this.hosts(body?.hosts);
            const value = validateSecretValue(body?.value);
            this.ensureVault();
            if ((await this.store.count(organizationId)) >= MAX_SECRETS_PER_ORG) {
                throw new UnprocessableEntityException(`An organization holds at most ${MAX_SECRETS_PER_ORG} Runtime secrets`);
            }
            const at = this.now().toISOString();
            const actor = actorOf(user);
            const record: RuntimeSecretRecord = { organizationId, secretId: secretIdOf(name), name, hosts, createdBy: actor, createdAt: at, updatedBy: actor, updatedAt: at, valueSetAt: at };
            const created = await this.store.create(record, this.audit(record, 'created', true, actor, at), () => this.vault.write(organizationId, record.secretId, { value, hosts }));
            if (!created) throw new ConflictException(`A secret named ${name} already exists; replace its value instead`);
            return secretView(created);
        });
    }
}

/** PATCH /runtime/secrets/:secretId — new hosts, a new value, or both. */
@Injectable()
export class UpdateRuntimeSecretUseCase extends SecretsUseCase {
    async execute({ user, secretId, body }: Caller & { secretId: string; body: { hosts?: unknown; value?: unknown } }) {
        const organizationId = organizationOf(user);
        const id = secretIdFrom(secretId);
        return mapped(async () => {
            const hosts = body?.hosts === undefined ? undefined : this.hosts(body.hosts);
            const value = body?.value === undefined ? undefined : validateSecretValue(body.value);
            if (!hosts && value === undefined) throw new InvalidRuntimeSecretError('change the hosts, the value, or both');
            this.ensureVault();
            const at = this.now().toISOString();
            const actor = actorOf(user);
            const updated = await this.store.update(
                organizationId,
                id,
                (current) => {
                    const next = { ...current, hosts: hosts ?? current.hosts, updatedBy: actor, updatedAt: at, valueSetAt: value === undefined ? current.valueSetAt : at };
                    return { next, audit: this.audit(next, 'updated', value !== undefined, actor, at) };
                },
                (_current, next) => (value === undefined ? this.vault.setHosts(organizationId, id, next.hosts) : this.vault.write(organizationId, id, { value, hosts: next.hosts })),
            );
            if (!updated) throw new NotFoundException('Secret not found');
            return secretView(updated);
        });
    }
}

/** DELETE /runtime/secrets/:secretId — every version leaves the store; the next request a machine makes is not injected. */
@Injectable()
export class DeleteRuntimeSecretUseCase extends SecretsUseCase {
    async execute({ user, secretId }: Caller & { secretId: string }) {
        const organizationId = organizationOf(user);
        const id = secretIdFrom(secretId);
        await mapped(async () => {
            this.ensureVault();
            const at = this.now().toISOString();
            const deleted = await this.store.delete(organizationId, id, (current) => this.audit(current, 'deleted', false, actorOf(user), at), () => this.vault.delete(organizationId, id));
            if (!deleted) throw new NotFoundException('Secret not found');
        });
    }
}

/** GET /runtime/secrets/audit — the org's secret changes, newest first. */
@Injectable()
export class ListRuntimeSecretAuditUseCase extends SecretsUseCase {
    async execute({ user, limit }: Caller & { limit?: string }) {
        const organizationId = organizationOf(user);
        const n = Number(limit ?? 50);
        if (!Number.isInteger(n) || n < 1 || n > 200) throw new BadRequestException('limit must be 1 to 200');
        const entries = await this.store.listAudit(organizationId, n);
        return { entries: entries.map(({ auditId, secretId, name, action, hosts, valueReplaced, actor, at }) => ({ auditId, secretId, name, action, hosts, valueReplaced, actor, at })) };
    }
}
