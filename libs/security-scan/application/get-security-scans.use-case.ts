import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { SecurityScanRecord } from '../domain/security-scan.types';
import {
    ISecurityScanRepository,
    SECURITY_SCAN_REPOSITORY_TOKEN,
} from '../infrastructure/security-scan.repository';

/**
 * A live scan writes to its record after every unit, and one job runs at
 * most 34 minutes: an hour of silence means the worker running it is gone.
 */
export const STALE_SCAN_AFTER_MS = 60 * 60 * 1000;

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
        await this.scans.failStale(organizationId, STALE_SCAN_AFTER_MS);
        return this.scans.findRecent(
            organizationId,
            repositoryIds,
            Math.min(Math.max(limit, 1), 100),
        );
    }

    async get(
        organizationId: string,
        scanId: string,
        repositoryIds: string[] | undefined,
    ): Promise<SecurityScanRecord> {
        const scan = await this.scans.findById(scanId).catch(() => null);
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
