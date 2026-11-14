import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { ENV_AUDIT_KINDS, type EnvAuditKind, type EnvAuditRecord, RUNTIME_ENV_AUDIT_STORE, type RuntimeEnvAuditStore } from '../../domain/ports';

const MAX_LIMIT = 200;

/** GET /runtime/audit?kind=env_exec — the org admin reads every env_exec (or env_fix) of the org's team keys: key, repo, command, when (S-27). */
@Injectable()
export class ListRuntimeAuditUseCase {
    constructor(@Inject(RUNTIME_ENV_AUDIT_STORE) private readonly audit: Pick<RuntimeEnvAuditStore, 'list'>) {}

    async execute(input: { user: Partial<IUser>; kind?: unknown; limit?: unknown; before?: unknown }): Promise<{ items: EnvAuditRecord[] }> {
        const organizationId = input.user?.organization?.uuid;
        if (!organizationId) throw new NotFoundException('Organization not found');
        if (typeof input.kind !== 'string' || !(ENV_AUDIT_KINDS as readonly string[]).includes(input.kind)) {
            throw new BadRequestException(`kind must be one of ${ENV_AUDIT_KINDS.join(', ')}`);
        }
        const limit = input.limit === undefined || input.limit === '' ? 50 : Number(input.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new BadRequestException(`limit must be between 1 and ${MAX_LIMIT}`);
        let before: string | undefined;
        if (input.before !== undefined && input.before !== '') {
            const t = typeof input.before === 'string' ? Date.parse(input.before) : NaN;
            if (Number.isNaN(t)) throw new BadRequestException('before must be an ISO date');
            before = new Date(t).toISOString();
        }
        const items = await this.audit.list({ organizationId, kind: input.kind as EnvAuditKind, limit, ...(before ? { before } : {}) });
        // The store is org-scoped; the filter here keeps a bad adapter from leaking another org's rows.
        return { items: items.filter((r) => r.organizationId === organizationId) };
    }
}
