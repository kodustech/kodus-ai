import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { CELL_TOKEN_TTL_MS, CELL_TOPOLOGIES, generateCellRegistrationToken, type CellTopology } from '../../domain/cell-token';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '../../domain/runtime-commands';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_CELL_READER,
    RUNTIME_CLOCK,
    isKodusOncall,
    type Clock,
    type RuntimeApiConfig,
    type RuntimeCell,
    type RuntimeCellReader,
} from '../../domain/ports';


const orgOf = (user: Partial<IUser>) => {
    const organizationId = user?.organization?.uuid;
    if (!organizationId || !user?.uuid) throw new NotFoundException('Organization not found');
    return organizationId;
};

const actorOf = (user: Partial<IUser>) => ({ userId: user.uuid!, ...(user.email ? { email: user.email } : {}) });

/**
 * POST /runtime/cells/registration-tokens — a single-use token, valid for 15
 * minutes, bound to the org and the topology (ADR-054). The plain token is
 * returned once; only its hash travels to the Runtime, which redeems it.
 */
@Injectable()
export class CreateCellRegistrationTokenUseCase {
    constructor(
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: IOutboxMessageRepository,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
    ) {}

    async execute(input: { user: Partial<IUser>; topology: unknown }) {
        const organizationId = orgOf(input.user);
        if (!(CELL_TOPOLOGIES as readonly unknown[]).includes(input.topology)) {
            throw new BadRequestException(`topology must be one of: ${CELL_TOPOLOGIES.join(', ')}`);
        }
        const topology = input.topology as CellTopology;
        const { token, tokenHash } = generateCellRegistrationToken();
        const expiresAt = new Date(this.now().getTime() + CELL_TOKEN_TTL_MS).toISOString();
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.CellTokenIssued,
                { tokenHash, organizationId, topology, expiresAt, issuedBy: actorOf(input.user) },
                tokenHash,
            ),
        );
        return { token, topology, expiresAt };
    }
}

/** The id of the aggregate entry that stands for the managed fleet; never a real cell id. */
export const KODUS_CLOUD_CELL_ID = 'kodus-cloud';

/**
 * The managed fleet as one entry: connected when any managed cell is. Managed
 * cells serve every org, so nothing per cell leaves (ids, certificate
 * serials, claims, heartbeats of a cell that holds another org's machines).
 */
export function kodusCloudCell(managed: RuntimeCell[]): RuntimeCell | null {
    const live = managed.filter((c) => c.owner === 'kodus' && c.status !== 'revoked');
    if (!live.length) return null;
    return {
        cellId: KODUS_CLOUD_CELL_ID,
        name: 'Kodus cloud',
        organizationId: null,
        owner: 'kodus',
        topology: 'managed',
        status: live.some((c) => c.status === 'connected') ? 'connected' : 'disconnected',
    };
}

/** GET /runtime/cells — the org's own cells and, when the managed fleet is up, "Kodus cloud". */
@Injectable()
export class ListRuntimeCellsUseCase {
    constructor(
        @Inject(RUNTIME_CELL_READER)
        private readonly cells: RuntimeCellReader,
    ) {}

    async execute(input: { user: Partial<IUser> }): Promise<RuntimeCell[]> {
        const organizationId = orgOf(input.user);
        const [own, managed] = await Promise.all([this.cells.listByOrganization(organizationId), this.cells.listManaged()]);
        const mine = own.filter((c) => c.organizationId === organizationId && c.owner === 'customer');
        const cloud = kodusCloudCell(managed);
        return cloud ? [cloud, ...mine] : mine;
    }
}

/** Who revokes: the org admin route (own cells only) or the ops route (managed cells, on-call only). */
export type CellRevokeScope = 'org' | 'ops';

/**
 * POST /runtime/cells/:id/revoke — the org admin revokes one of the org's
 * cells (scope `org`, the default); a managed cell only through the ops route
 * (scope `ops`) by the Kodus on-call. Anything else is 404.
 */
@Injectable()
export class RevokeRuntimeCellUseCase {
    constructor(
        @Inject(RUNTIME_CELL_READER)
        private readonly cells: RuntimeCellReader,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: IOutboxMessageRepository,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
    ) {}

    async execute(input: { user: Partial<IUser>; cellId: string; reason?: string; scope?: CellRevokeScope }) {
        const organizationId = orgOf(input.user);
        const scope: CellRevokeScope = input.scope ?? 'org';
        const cell = typeof input.cellId === 'string' && input.cellId.length <= 128 ? await this.cells.get(input.cellId) : null;
        const managed = cell?.owner === 'kodus';
        const allowed =
            !!cell &&
            (scope === 'ops' ? managed && isKodusOncall(this.config, input.user) : !managed && cell.organizationId === organizationId);
        if (!allowed) throw new NotFoundException('Cell not found');
        if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 500)) {
            throw new BadRequestException('reason must be a string of at most 500 characters');
        }
        if (cell.status === 'revoked') return { cellId: cell.cellId, status: 'revoked' as const };

        const requestedAt = this.now().toISOString();
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.CellRevokeRequested,
                {
                    cellId: cell.cellId,
                    ...(cell.organizationId ? { organizationId: cell.organizationId } : {}),
                    requestedBy: actorOf(input.user),
                    requestedAt,
                    ...(input.reason ? { reason: input.reason } : {}),
                },
                `${cell.cellId}:revoke`,
            ),
        );
        return { cellId: cell.cellId, status: 'revoke_requested' as const, requestedAt };
    }
}
