import { randomUUID } from 'crypto';

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { RuntimeCommandName, runtimeCommandOutboxMessage } from '../../domain/runtime-commands';
import { isKodusOncall, RUNTIME_API_CONFIG, RUNTIME_CLOCK, type Clock, type RuntimeApiConfig } from '../../domain/ports';

/** @deprecated use isKodusOncall from domain/ports. */
export const isOncall = isKodusOncall;

/**
 * POST /runtime/stop — the stop button: the Runtime cancels the Runs, denies
 * new claims, destroys the machines and revokes pending download tokens.
 * `org` is for the org admin (checked by the route); `global` only for the
 * Kodus on-call.
 */
@Injectable()
export class StopRuntimeUseCase {
    constructor(
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: IOutboxMessageRepository,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
    ) {}

    async execute(input: { user: Partial<IUser>; scope: unknown }) {
        const organizationId = input.user?.organization?.uuid;
        if (!organizationId || !input.user?.uuid) throw new NotFoundException('Organization not found');
        if (input.scope !== 'org' && input.scope !== 'global') {
            throw new BadRequestException("scope must be 'org' or 'global'");
        }
        if (input.scope === 'global' && !isKodusOncall(this.config, input.user)) {
            throw new ForbiddenException('Only the Kodus on-call can stop the Runtime globally');
        }

        const correlationId = randomUUID();
        const requestedAt = this.now().toISOString();
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.StopRequested,
                {
                    ...(input.scope === 'org' ? { scope: 'org' as const, organizationId } : { scope: 'global' as const }),
                    requestedBy: { userId: input.user.uuid, ...(input.user.email ? { email: input.user.email } : {}) },
                    requestedAt,
                    correlationId,
                },
                correlationId,
            ),
        );
        return { scope: input.scope, requestedAt, correlationId };
    }
}

/**
 * POST /runtime/stop/clear — reopens the Runtime after a stop: the Runtime
 * sets `cleared_at` on the active stops of the scope requested up to now.
 * Same rules as the stop: `org` for the org admin, `global` only on-call.
 */
@Injectable()
export class ClearRuntimeStopUseCase {
    constructor(
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: IOutboxMessageRepository,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
    ) {}

    async execute(input: { user: Partial<IUser>; scope: unknown }) {
        const organizationId = input.user?.organization?.uuid;
        if (!organizationId || !input.user?.uuid) throw new NotFoundException('Organization not found');
        if (input.scope !== 'org' && input.scope !== 'global') {
            throw new BadRequestException("scope must be 'org' or 'global'");
        }
        if (input.scope === 'global' && !isKodusOncall(this.config, input.user)) {
            throw new ForbiddenException('Only the Kodus on-call can clear a global stop');
        }

        const correlationId = randomUUID();
        const clearedAt = this.now().toISOString();
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.StopCleared,
                {
                    ...(input.scope === 'org' ? { scope: 'org' as const, organizationId } : { scope: 'global' as const }),
                    clearedBy: { userId: input.user.uuid, ...(input.user.email ? { email: input.user.email } : {}) },
                    clearedAt,
                    correlationId,
                },
                correlationId,
            ),
        );
        return { scope: input.scope, clearedAt, correlationId };
    }
}
