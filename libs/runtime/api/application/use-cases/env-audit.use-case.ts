import { BadRequestException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { PREVIEW_ID_PATTERN } from '@libs/runtime/contracts/preview';

import { ENV_AUDIT_KINDS, type EnvAuditKind, type EnvAuditRecord, RUNTIME_ENV_AUDIT_STORE, type RuntimeEnvAuditStore } from '../../domain/ports';
import { type PreviewAuditRecord, RUNTIME_PREVIEW_AUDIT_READER, type RuntimePreviewAuditReader } from '../../domain/previews';

const MAX_LIMIT = 200;

const KINDS = [...ENV_AUDIT_KINDS, 'preview'] as const;

/**
 * GET /runtime/audit?kind=env_exec — the org admin reads every env_exec (or
 * env_fix) of the org's team keys: key, repo, command, when (S-27). With
 * kind=preview, the org's preview activity (docs/runtime/preview-urls.md
 * §6.7): every session opened or refused, start, wake, sleep, stop and
 * expiry, of one preview when `previewId` is set.
 */
@Injectable()
export class ListRuntimeAuditUseCase {
    constructor(
        @Inject(RUNTIME_ENV_AUDIT_STORE) private readonly audit: Pick<RuntimeEnvAuditStore, 'list'>,
        @Optional() @Inject(RUNTIME_PREVIEW_AUDIT_READER) private readonly previews?: RuntimePreviewAuditReader,
    ) {}

    async execute(input: { user: Partial<IUser>; kind?: unknown; limit?: unknown; before?: unknown; previewId?: unknown }): Promise<{ items: EnvAuditRecord[] | PreviewAuditRecord[] }> {
        const organizationId = input.user?.organization?.uuid;
        if (!organizationId) throw new NotFoundException('Organization not found');
        if (typeof input.kind !== 'string' || !(KINDS as readonly string[]).includes(input.kind)) {
            throw new BadRequestException(`kind must be one of ${KINDS.join(', ')}`);
        }
        const limit = input.limit === undefined || input.limit === '' ? 50 : Number(input.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new BadRequestException(`limit must be between 1 and ${MAX_LIMIT}`);
        let before: string | undefined;
        if (input.before !== undefined && input.before !== '') {
            const t = typeof input.before === 'string' ? Date.parse(input.before) : NaN;
            if (Number.isNaN(t)) throw new BadRequestException('before must be an ISO date');
            before = new Date(t).toISOString();
        }
        if (input.kind === 'preview') {
            if (input.previewId !== undefined && input.previewId !== '' && (typeof input.previewId !== 'string' || !PREVIEW_ID_PATTERN.test(input.previewId))) {
                throw new BadRequestException('previewId must be a preview id');
            }
            if (!this.previews) throw new ServiceUnavailableException('Preview activity is not readable on this deployment');
            const rows = await this.previews.list({ organizationId, limit, ...(before ? { before } : {}), ...(input.previewId ? { previewId: input.previewId as string } : {}) });
            return { items: rows.filter((r) => r.organizationId === organizationId) };
        }
        const items = await this.audit.list({ organizationId, kind: input.kind as EnvAuditKind, limit, ...(before ? { before } : {}) });
        // The store is org-scoped; the filter here keeps a bad adapter from leaking another org's rows.
        return { items: items.filter((r) => r.organizationId === organizationId) };
    }
}
