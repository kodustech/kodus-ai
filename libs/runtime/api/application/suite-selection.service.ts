import { Inject, Injectable } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { OUTBOX_MESSAGE_REPOSITORY_TOKEN, type IOutboxMessageRepository } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { sha256, uuidV5From } from '@libs/runtime/contracts/derive-id';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '@libs/runtime/contracts/runtime-commands';

import { RUNTIME_CLOCK, type Clock } from '../domain/ports';

/**
 * A person turns spec selection on or off for an environment (docs/runtime/e2e-suites.md section 6.1, D14). The selection state is the
 * Runtime's table: the product never writes it, it puts `runtime.suite.selection_changed` on the outbox and the worker applies it.
 * Turning it on also lifts a brake the shadow check set.
 */
@Injectable()
export class RuntimeSuiteSelection {
    constructor(
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN) private readonly outbox: Pick<IOutboxMessageRepository, 'create'>,
        @Inject(RUNTIME_CLOCK) private readonly now: Clock,
    ) {}

    async set(input: { user: Partial<IUser>; organizationId: string; environmentId: string; selection: 'on' | 'off' }): Promise<void> {
        const requestedAt = this.now().toISOString();
        const key = `suite-selection:${input.environmentId}:${input.selection}:${requestedAt}`;
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.SuiteSelectionChanged,
                {
                    organizationId: input.organizationId,
                    environmentId: input.environmentId,
                    selection: input.selection,
                    requestedBy: { userId: input.user.uuid!, ...(input.user.email ? { email: input.user.email } : {}) },
                    requestedAt,
                    key,
                },
                uuidV5From(sha256(key)),
            ),
        );
    }
}
