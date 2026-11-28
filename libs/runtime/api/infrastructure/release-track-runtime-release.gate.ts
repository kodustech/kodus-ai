import { Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { isKodyRuntimeReleasedToTrack } from '@libs/feature-gate/domain/kody-runtime-release';
import { isReleaseTrack } from '@libs/feature-gate/domain/release-track';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';

import type { RuntimeReleaseGate } from '../domain/ports';

const LOGGED_LIMIT = 1000;

/**
 * Kody Runtime is released by the org's stored release track alone: an org on
 * `alpha` sees it, `beta` and `stable` do not, in cloud and self-hosted alike.
 * No flag service is asked. The `kody-runtime` catalog entry (stage alpha)
 * documents the feature; the web layout asks the same predicate.
 * Fails closed: no org, an org not found, a track that cannot be read or is
 * not a known track is a no, logged once per org.
 */
@Injectable()
export class ReleaseTrackRuntimeRelease implements RuntimeReleaseGate {
    private readonly logger = createLogger(ReleaseTrackRuntimeRelease.name);
    private readonly logged = new Set<string>();

    constructor(
        // Optional so a module without the organization service still boots; the
        // track is then unreadable and the Runtime stays closed.
        @Optional()
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizations?: Pick<IOrganizationService, 'findOne'>,
    ) {}

    async isEnabledFor(organizationId: string | undefined): Promise<boolean> {
        if (!organizationId) return false;
        if (!this.organizations) {
            this.warnOnce('*', 'organization service unavailable');
            return false;
        }
        let track: unknown;
        try {
            const org = await this.organizations.findOne({ uuid: organizationId });
            if (!org) {
                this.warnOnce(organizationId, 'organization not found');
                return false;
            }
            track = org.releaseTrack;
        } catch (error) {
            this.warnOnce(organizationId, 'release track read failed', error);
            return false;
        }
        if (typeof track !== 'string' || !isReleaseTrack(track)) {
            this.warnOnce(organizationId, 'unknown release track');
            return false;
        }
        return isKodyRuntimeReleasedToTrack(track);
    }

    private warnOnce(organizationId: string, reason: string, error?: unknown): void {
        const key = `${organizationId}:${reason}`;
        if (this.logged.has(key)) return;
        if (this.logged.size >= LOGGED_LIMIT) this.logged.clear();
        this.logged.add(key);
        this.logger.warn({
            message: `Kody Runtime release track unreadable (${reason}); treating it as off`,
            context: ReleaseTrackRuntimeRelease.name,
            metadata: {
                organizationId,
                reason,
                ...(error ? { errorName: error instanceof Error ? error.name : 'error' } : {}),
            },
        });
    }
}
