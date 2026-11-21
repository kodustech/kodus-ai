import { Logger } from '@nestjs/common';

import { RuntimeCommandName, RuntimeOrganizationPurgeRequestedSchema } from '@libs/runtime/contracts/runtime-commands';
import type { RunProjectionStore } from '@libs/runtime/run';

import type { EvidenceStore } from '../../shared/evidence/file-evidence-store';
import type { OrganizationPurgeStore } from '../../shared/persistence/organization-purge';
import type { ClaimReleaser } from '../run/ports';
import type { CommandHandler } from './command-handlers';
import type { RunEngine } from './run-engine.port';

/** The organization still has a live Run or a claim that was not released: the broker retries the command with a delay. */
export class OrganizationPurgeNotReadyError extends Error {
    constructor(
        readonly liveRuns: number,
        readonly liveClaims: number,
    ) {
        super(`organization purge waits for ${liveRuns} live Runs and ${liveClaims} live claims`);
    }
}

/**
 * Every Runtime datum of one organization (docs/runtime/architecture.md "Data lifecycle"): it cancels the live Runs,
 * releases the live claims through the hub, and only when no Run or claim is live deletes the evidence under
 * `{orgId}/` and every row of the organization.
 *
 * - A Run is stopped with `engine.stop`, which starts its finalization and returns; the handler never waits on it.
 *   The finalization (and the hub's release) ends the claims within seconds, so the first delivery usually finds
 *   them still live and throws: the control lane retries with a growing delay, and the retry finds them ended.
 * - Nothing is deleted while a machine may still run: a row the reaper or the hub needs to end it would be gone.
 * - Idempotent: a second command, or a retry after a partial delete, finds the rest (the evidence and every
 *   statement are deletes by prefix or by the organization).
 * - The summary names the organization and counts only.
 */
export class OrganizationPurgeRequestedHandler implements CommandHandler {
    readonly event = RuntimeCommandName.OrganizationPurgeRequested;
    private readonly logger = new Logger('OrganizationPurge');

    constructor(
        private readonly engine: Pick<RunEngine, 'stop'>,
        private readonly projection: Pick<RunProjectionStore, 'listLive'>,
        private readonly purge: OrganizationPurgeStore,
        private readonly releaser: ClaimReleaser,
        /** Null when no evidence store is configured: there is no object to delete. */
        private readonly evidence: Pick<EvidenceStore, 'deletePrefix'> | null,
    ) {}

    async handle(body: Record<string, unknown>) {
        const p = RuntimeOrganizationPurgeRequestedSchema.safeParse(body);
        if (!p.success) return { invalid: 'invalid organization purge', detail: p.error.message };
        const organizationId = p.data.organizationId;

        for (const r of await this.projection.listLive(organizationId)) {
            await this.engine.stop(
                { runId: r.runId, attempt: r.attempt, organizationId: r.organizationId, correlationId: r.correlationId, headSha: r.headSha },
                'cancelled',
                'organization data purged',
            );
        }
        // Pools stop taking demand, so runtime-fleet drains their hosts; a host that is not terminated yet stays (hostsKept).
        const cordoned = await this.purge.cordonPools(organizationId);
        let releaseFailures = 0;
        for (const c of await this.purge.liveClaims(organizationId)) {
            await this.releaser.release({ claimId: c.claimId, organizationId, runId: c.runId }).catch(() => {
                releaseFailures++;
            });
        }

        const [liveRuns, liveClaims] = [(await this.projection.listLive(organizationId)).length, (await this.purge.liveClaims(organizationId)).length];
        if (liveRuns || liveClaims) {
            this.logger.warn({ msg: 'organization_purge.waiting', organizationId, reason: p.data.reason, liveRuns, liveClaims, releaseFailures });
            throw new OrganizationPurgeNotReadyError(liveRuns, liveClaims);
        }

        // The evidence first: a failure retries the command with every row still in place.
        const evidenceObjects = this.evidence ? await this.evidence.deletePrefix(`${organizationId}/`) : 0;
        const { deleted, hostsKept } = await this.purge.deleteOrganization(organizationId);
        const rows = Object.values(deleted).reduce((a, b) => a + b, 0);
        this.logger.log({ msg: 'organization_purge.done', organizationId, reason: p.data.reason, rows, tables: deleted, evidenceObjects, poolsCordoned: cordoned, hostsKept });
        if (hostsKept) this.logger.warn({ msg: 'organization_purge.hosts_kept', organizationId, hostsKept });
    }
}
