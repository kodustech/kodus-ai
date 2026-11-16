import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
    Optional,
    UnprocessableEntityException,
} from '@nestjs/common';

import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

import { DEFAULT_EGRESS_DENYLIST, deniedBy, InvalidEgressHostError, normalizeEgressHost } from '../../domain/egress';
import { DEFAULT_INSPECTED_PATHS, EGRESS_APPROVAL_MODES, type EgressApprovalMode, ORG_EGRESS_SCOPE } from '@libs/runtime/contracts/egress';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '@libs/runtime/contracts/runtime-commands';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_READER,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    type Clock,
    type ProductEnvironmentStore,
    type RuntimeApiConfig,
    type RuntimeEnvironmentReader,
} from '../../domain/ports';
import { environmentRepositoryIds, RuntimeEnvironmentMembers } from '../environment-members.service';
import { RuntimeEgressAccess } from '../egress-access.service';
import type { RuntimeAuthorization } from '../run-access.service';

export interface ApproveEgressInput {
    user: Partial<IUser>;
    /** An environment id, or ORG_EGRESS_SCOPE for the org list (owners only). */
    environmentId: string;
    host: string;
    /** inspected (the default: GET/HEAD under pathPrefixes, '/' when none) or passthrough (full access). */
    mode?: EgressApprovalMode;
    pathPrefixes?: string[];
    source?: 'blocker' | 'settings';
    /** The blocker signature with its setup or Run id, for the audit. */
    sourceRef?: string;
    reason?: string;
}

const PATH_PREFIX = /^\/[\x21-\x7e]{0,255}$/;

/** An inspected approval's prefixes: each starts with /, no dot segment, at most 16; '/' when none is named. */
export function inspectedPathPrefixes(raw: unknown): string[] {
    if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return [...DEFAULT_INSPECTED_PATHS];
    if (!Array.isArray(raw) || raw.length > 16) throw new BadRequestException('pathPrefixes: at most 16 paths');
    const out = [...new Set(raw.map((p) => (typeof p === 'string' ? p.trim() : '')))];
    for (const p of out) {
        if (!PATH_PREFIX.test(p) || p.split('/').some((seg) => seg === '.' || seg === '..')) {
            throw new BadRequestException(`pathPrefixes: ${JSON.stringify(p).slice(0, 80)} is not a path that starts with /`);
        }
    }
    return out;
}

/**
 * POST /runtime/environments/:id/egress-approvals — one host for one
 * environment (or the org list, ORG_EGRESS_SCOPE), outside the recipe. The
 * Kodus denylist wins. Inspected by default (docs/runtime/egress-allowlist.md
 * §9): only reads under its paths leave the cell; full access is asked for.
 * Who may: RuntimeEgressAccess (D3). The environment is the product's row (it
 * exists before any Run, so egress a setup was denied can be approved); one
 * only Runs know is the fallback.
 */
@Injectable()
export class ApproveEgressUseCase {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly productEnvironments: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(RUNTIME_ENVIRONMENT_READER)
        private readonly environments: RuntimeEnvironmentReader,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: IOutboxMessageRepository,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        // Required by Nest; made without it (the older tests), only the environment's own repository is checked.
        @Inject(RuntimeEnvironmentMembers)
        private readonly members?: RuntimeEnvironmentMembers,
        // Required by Nest; made without it (the older tests), owners only, as before D3.
        @Optional()
        @Inject(RuntimeEgressAccess)
        private readonly access?: RuntimeEgressAccess,
    ) {}

    async execute(input: ApproveEgressInput) {
        const organizationId = input.user?.organization?.uuid;
        const scope = await resolveEgressScope(input, organizationId, this.productEnvironments, this.environments);
        if (scope.org) {
            await (this.access ?? new RuntimeEgressAccess(this.authorization)).ensureOrgAdmin(input.user);
        } else {
            const repoIds = await environmentRepositoryIds(this.members, { ...scope.environment!, organizationId: organizationId! });
            await (this.access ?? new RuntimeEgressAccess(this.authorization)).ensureMayChangeEnvironment(input.user, organizationId!, repoIds);
        }

        let host: string;
        try {
            host = normalizeEgressHost(input.host);
        } catch (e) {
            if (e instanceof InvalidEgressHostError) throw new BadRequestException(e.message);
            throw e;
        }
        const rule = deniedBy(host, [...DEFAULT_EGRESS_DENYLIST, ...this.config.egressDenylist]);
        if (rule) {
            throw new UnprocessableEntityException(`${host} is on the Kodus egress denylist (${rule}) and cannot be approved`);
        }
        const mode: EgressApprovalMode = input.mode ?? 'inspected';
        if (!EGRESS_APPROVAL_MODES.includes(mode)) throw new BadRequestException('mode: inspected or passthrough');
        const pathPrefixes = mode === 'inspected' ? inspectedPathPrefixes(input.pathPrefixes) : undefined;
        const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 500) : undefined;
        const sourceRef = typeof input.sourceRef === 'string' && input.sourceRef ? input.sourceRef.slice(0, 256) : undefined;

        const approvedAt = this.now().toISOString();
        const key = `${scope.environmentId}:${host}`;
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.EgressApproved,
                {
                    environmentId: scope.environmentId,
                    organizationId: organizationId!,
                    host,
                    approvedBy: { userId: input.user.uuid!, ...(input.user.email ? { email: input.user.email } : {}) },
                    approvedAt,
                    mode,
                    ...(pathPrefixes ? { pathPrefixes } : {}),
                    source: input.source === 'settings' ? 'settings' : 'blocker',
                    ...(sourceRef ? { sourceRef } : {}),
                    ...(reason ? { reason } : {}),
                    key,
                },
                `${key}@${approvedAt}`,
            ),
        );
        return { environmentId: scope.environmentId, host, approvedAt, mode, ...(pathPrefixes ? { pathPrefixes } : {}) };
    }
}

/**
 * The scope an egress change names: the org list (ORG_EGRESS_SCOPE) or one environment of the caller's org. Another
 * org's environment answers 404.
 */
export async function resolveEgressScope(
    input: { environmentId: string },
    organizationId: string | undefined,
    productEnvironments: Pick<ProductEnvironmentStore, 'get'>,
    environments: RuntimeEnvironmentReader,
): Promise<{ org: boolean; environmentId: string; environment?: { environmentId: string; organizationId: string; repositoryId: string } }> {
    if (!organizationId) throw new NotFoundException('Environment not found');
    if (input.environmentId === ORG_EGRESS_SCOPE) return { org: true, environmentId: ORG_EGRESS_SCOPE };
    const valid = typeof input.environmentId === 'string' && input.environmentId.length <= 128;
    const environment = valid
        ? ((await productEnvironments.get(organizationId, input.environmentId)) ?? (await environments.get(organizationId, input.environmentId)))
        : null;
    if (!environment || environment.organizationId !== organizationId) throw new NotFoundException('Environment not found');
    return { org: false, environmentId: environment.environmentId, environment };
}
