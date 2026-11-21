import { randomUUID } from 'crypto';

import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { IOutboxMessageRepository, OUTBOX_MESSAGE_REPOSITORY_TOKEN } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '@libs/runtime/contracts/runtime-commands';

import { RUNTIME_ORGANIZATION_PURGE_STORE, type RuntimeOrganizationPurgeStore } from '../../domain/organization-purge';
import { RUNTIME_CLOCK, type Clock } from '../../domain/ports';
import { RUNTIME_SECRET_VAULT, type RuntimeSecretVaultPort } from '../../domain/secrets';

export type RuntimePurgeReason = 'organization_deleted' | 'owner_requested';

/**
 * Every Runtime datum of one organization leaves (docs/runtime/architecture.md "Data lifecycle"): a customer who
 * leaves, or an org deleted in the product, keeps nothing behind. In this order:
 *
 *  1. every OpenBao secret of the org is deleted, by the ids `runtime_secrets` names;
 *  2. the product Postgres rows of the org that the Runtime keeps are deleted, through the purge store;
 *  3. `runtime.organization.purge_requested` goes on the outbox: the runtime-worker cancels the live Runs, releases
 *     the claims and deletes the Runtime Postgres rows and the evidence (the API never writes that database).
 *
 * A secret OpenBao would not delete keeps its metadata (and the audit), the command is sent anyway, and the use case
 * ends in a 503: the product row is the only record of the secret's id, so running it again finishes the job.
 * Running it twice is fine: a second run finds no secret and no row, and sends the command again, which the worker
 * applies to nothing. The outbox retries a command that could not be published; a failure before it is the caller's
 * to log (the organization's deletion never waits on it).
 */
@Injectable()
export class PurgeRuntimeOrganizationUseCase {
    private readonly logger = createLogger(PurgeRuntimeOrganizationUseCase.name);

    constructor(
        @Inject(RUNTIME_ORGANIZATION_PURGE_STORE) private readonly store: RuntimeOrganizationPurgeStore,
        @Inject(RUNTIME_SECRET_VAULT) private readonly vault: RuntimeSecretVaultPort,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN) private readonly outbox: IOutboxMessageRepository,
        @Inject(RUNTIME_CLOCK) private readonly now: Clock,
    ) {}

    /** The explicit purge (POST /runtime/organization-data/purge): the owner of the caller's org, who typed the org id. */
    async executeConfirmed(input: { user: Partial<IUser>; confirm: unknown }) {
        const organizationId = input.user?.organization?.uuid;
        if (!organizationId || !input.user?.uuid) throw new NotFoundException('Organization not found');
        // The id the owner must type is the org's own: a body for another org, or a copy-paste of the wrong one, is refused.
        if (typeof input.confirm !== 'string' || input.confirm !== organizationId) {
            throw new BadRequestException('confirm must be the id of this organization');
        }
        return this.execute({ organizationId, reason: 'owner_requested', requestedBy: { userId: input.user.uuid, ...(input.user.email ? { email: input.user.email } : {}) } });
    }

    async execute(input: { organizationId: string; reason: RuntimePurgeReason; requestedBy?: { userId: string; email?: string } }) {
        const { organizationId } = input;
        const secretIds = await this.store.secretIds(organizationId);
        const stuck: string[] = [];
        for (const secretId of secretIds) {
            try {
                // 404 is already gone, which is what a delete wants (OpenBaoSecretVault.delete).
                await this.vault.delete(organizationId, secretId);
            } catch {
                // The vault's errors carry no value; the id of the secret is metadata the org owns.
                stuck.push(secretId);
            }
        }

        const removed = await this.store.purgeOrganization(organizationId, { keepSecretIds: stuck });
        const requestedAt = this.now().toISOString();
        const messageId = randomUUID();
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.OrganizationPurgeRequested,
                { organizationId, requestedAt, reason: input.reason, ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}) },
                messageId,
            ),
        );

        const rows = Object.values(removed).reduce((a, b) => a + b, 0);
        this.logger.log({
            message: 'Runtime organization purge requested',
            context: PurgeRuntimeOrganizationUseCase.name,
            metadata: { organizationId, reason: input.reason, secretsDeleted: secretIds.length - stuck.length, secretsStuck: stuck.length, productRows: rows },
        });
        if (stuck.length) {
            throw new ServiceUnavailableException(`${stuck.length} secret(s) could not be deleted from the secret store; the rest of the purge was requested. Run it again to finish.`);
        }
        return { organizationId, requestedAt, secretsDeleted: secretIds.length, productRows: rows };
    }
}
