import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { ORGANIZATION_DELETED_EVENT, OrganizationDeletedEvent } from '@libs/core/domain/events/organization-deleted.event';
import { createLogger } from '@libs/core/log/logger';
import { kodyRuntimeEnabledInThisProcess } from '@libs/runtime-publish/runtime-feature';

import { PurgeRuntimeOrganizationUseCase } from '../application/use-cases/purge-organization.use-case';

/** Waits before each try: at once, then after a short and a longer pause (a database or secret store that blinked). */
export const PURGE_RETRY_DELAYS_MS: readonly number[] = [0, 2_000, 15_000];

/**
 * When the product deletes an organization, its Runtime data goes with it (PurgeRuntimeOrganizationUseCase). Best
 * effort: the organization's deletion never waits on it and never fails because of it. A try that fails before the
 * command is on the outbox is logged and tried again a few times; the command itself is retried by the outbox.
 * A deployment without the Runtime has nothing to purge.
 */
@Injectable()
export class OrganizationDeletedPurgeListener {
    private readonly logger = createLogger(OrganizationDeletedPurgeListener.name);

    /** A spec sets it to retry without waiting. */
    delaysMs: readonly number[] = PURGE_RETRY_DELAYS_MS;

    constructor(private readonly purge: PurgeRuntimeOrganizationUseCase) {}

    @OnEvent(ORGANIZATION_DELETED_EVENT)
    async handle(event: OrganizationDeletedEvent): Promise<void> {
        if (!event?.organizationId || !kodyRuntimeEnabledInThisProcess()) return;
        const { organizationId } = event;
        for (let attempt = 0; attempt < this.delaysMs.length; attempt++) {
            if (this.delaysMs[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, this.delaysMs[attempt]));
            try {
                await this.purge.execute({ organizationId, reason: 'organization_deleted' });
                return;
            } catch (error) {
                const last = attempt === this.delaysMs.length - 1;
                this.logger[last ? 'error' : 'warn']({
                    message: last ? 'Runtime organization purge failed; run PurgeRuntimeOrganizationUseCase again for this organization' : 'Runtime organization purge failed; trying again',
                    context: OrganizationDeletedPurgeListener.name,
                    error: error instanceof Error ? error : undefined,
                    metadata: { organizationId, attempt: attempt + 1 },
                });
            }
        }
    }
}
