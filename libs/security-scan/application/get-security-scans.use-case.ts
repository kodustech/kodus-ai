import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';

import { SecurityScanRecord } from '../domain/security-scan.types';
import {
    ISecurityScanRepository,
    SECURITY_SCAN_REPOSITORY_TOKEN,
    StaleScanWindows,
} from '../infrastructure/security-scan.repository';

/**
 * A running scan writes to its record after every unit, and one job runs at
 * most 34 minutes: an hour of silence means the worker running it is gone. A
 * queued one (new, or between two jobs) waits as long as the queue's backlog,
 * so it is given a day before its job is taken as lost.
 */
export const STALE_SCAN_AFTER: StaleScanWindows = {
    runningMs: 60 * 60 * 1000,
    queuedMs: 24 * 60 * 60 * 1000,
};

@Injectable()
export class GetSecurityScansUseCase {
    constructor(
        @Inject(SECURITY_SCAN_REPOSITORY_TOKEN)
        private readonly scans: ISecurityScanRepository,
    ) {}

    /** `repositoryIds` = the repositories the caller may see; undefined = all. */
    async list(
        organizationId: string,
        repositoryIds: string[] | undefined,
        limit = 20,
    ): Promise<SecurityScanRecord[]> {
        await this.scans.failStale(organizationId, STALE_SCAN_AFTER);
        return this.scans.findRecent(
            organizationId,
            repositoryIds,
            Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20,
        );
    }

    async get(
        organizationId: string,
        scanId: string,
        repositoryIds: string[] | undefined,
    ): Promise<SecurityScanRecord> {
        // Not an id a scan could have: as unknown as one that does not exist.
        const scan = isValidObjectId(scanId)
            ? await this.scans.findById(scanId)
            : null;
        if (
            !scan ||
            scan.organizationId !== organizationId ||
            (repositoryIds && !repositoryIds.includes(scan.repository.id))
        ) {
            throw new NotFoundException('Security scan not found.');
        }
        return scan;
    }
}
