import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { CELL_TOKEN_TTL_MS, CELL_TOPOLOGIES, cellTokenState, generateCellRegistrationToken, isCellTokenId, type CellTopology } from '../../domain/cell-token';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '../../domain/runtime-commands';
import type { CellRegistrationTokenView } from '@libs/runtime/contracts/views/cells';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_CELL_READER,
    RUNTIME_CELL_TOKEN_READER,
    RUNTIME_CLOCK,
    isKodusOncall,
    type Clock,
    type RuntimeApiConfig,
    type RuntimeCell,
    type RuntimeCellReader,
    type RuntimeCellTokenReader,
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
        // id: the token's hash, the Runtime's key for it (lists and revokes it; registers nothing).
        return { id: tokenHash, token, topology, expiresAt };
    }
}

// The view lives in contracts/views/cells.ts (the web imports it too); re-exported for the callers that imported it from here.
export type { CellRegistrationTokenView };

/** How far back the token list goes: enough to see who made the tokens of today's installs. */
export const CELL_TOKEN_LIST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * GET /runtime/cells/registration-tokens — the org's tokens of the last 24 h,
 * newest first, with their state. Never the token: only its hash is stored.
 */
@Injectable()
export class ListCellRegistrationTokensUseCase {
    constructor(
        @Inject(RUNTIME_CELL_TOKEN_READER)
        private readonly tokens: RuntimeCellTokenReader,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
    ) {}

    async execute(input: { user: Partial<IUser> }): Promise<CellRegistrationTokenView[]> {
        const organizationId = orgOf(input.user);
        const now = this.now();
        const rows = await this.tokens.listByOrganization(organizationId, new Date(now.getTime() - CELL_TOKEN_LIST_WINDOW_MS));
        return rows
            .filter((t) => t.organizationId === organizationId)
            .map((t) => ({
                id: t.tokenHash,
                topology: t.topology,
                issuedBy: t.issuedBy,
                issuedAt: t.issuedAt,
                expiresAt: t.expiresAt,
                state: cellTokenState(t, now),
                ...(t.usedAt ? { usedAt: t.usedAt } : {}),
                ...(t.revokedAt ? { revokedAt: t.revokedAt } : {}),
            }));
    }
}

/**
 * POST /runtime/cells/registration-tokens/:id/revoke — revokes a pending
 * token of the caller's org (docs/runtime/self-hosted.md). Another org's or
 * an unknown token is 404; a used, expired or revoked one is 409, with its
 * state. Through the outbox, like a cell revoke: a redemption that lands
 * first wins, and its cell is revoked as a cell.
 */
@Injectable()
export class RevokeCellRegistrationTokenUseCase {
    constructor(
        @Inject(RUNTIME_CELL_TOKEN_READER)
        private readonly tokens: RuntimeCellTokenReader,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: IOutboxMessageRepository,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
    ) {}

    async execute(input: { user: Partial<IUser>; id: string }) {
        const organizationId = orgOf(input.user);
        const row = isCellTokenId(input.id) ? await this.tokens.get(input.id) : null;
        if (!row || row.organizationId !== organizationId) throw new NotFoundException('Registration token not found');
        const now = this.now();
        const state = cellTokenState(row, now);
        if (state !== 'pending') throw new ConflictException({ message: `The registration token is ${state}`, state });
        const revokedAt = now.toISOString();
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.CellTokenRevoked,
                { tokenHash: row.tokenHash, organizationId, revokedBy: actorOf(input.user), revokedAt },
                `${row.tokenHash}:revoke`,
            ),
        );
        return { id: row.tokenHash, state: 'revoke_requested' as const, revokedAt };
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
