import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { repositoryHost } from '@libs/issues/domain/scan-fingerprint';
import {
    INTEGRATION_CONFIG_SERVICE_TOKEN,
    IIntegrationConfigService,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';

import { SecurityScanRecord } from '../domain/security-scan.types';
import {
    ISecurityScanRepository,
    SECURITY_SCAN_REPOSITORY_TOKEN,
    StaleScanWindows,
    ScanRepositoryKey,
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
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly configs: IIntegrationConfigService,
    ) {}

    /** Legacy permission ids identify no instance: ambiguous ids fail closed. */
    private async repositoryScope(
        organizationId: string,
        ids: string[] | undefined,
    ): Promise<ScanRepositoryKey[] | undefined> {
        if (ids === undefined) return undefined;
        if (!ids.length) return [];
        const configs = await this.configs.findByOrganizationAndConfigKey(
            organizationId,
            IntegrationConfigKey.REPOSITORIES,
        );
        const allowed = new Set(ids);
        const byId = new Map<string, Map<string, ScanRepositoryKey>>();
        for (const config of configs) {
            const platform = config.integration?.platform;
            if (!platform || !Array.isArray(config.configValue)) continue;
            for (const repository of config.configValue) {
                const id = String(repository?.id);
                if (!allowed.has(id)) continue;
                const host = repositoryHost(repository.http_url);
                const key = { id, platform, host };
                const candidates = byId.get(id) ?? new Map();
                candidates.set(JSON.stringify(key), key);
                byId.set(id, candidates);
            }
        }
        return [...byId.values()].flatMap((candidates) =>
            candidates.size === 1 && [...candidates.values()][0].host
                ? [...candidates.values()]
                : [],
        );
    }

    /** `repositoryIds` = the repositories the caller may see; undefined = all. */
    async list(
        organizationId: string,
        repositoryIds: string[] | undefined,
        limit = 20,
    ): Promise<SecurityScanRecord[]> {
        await this.scans.failStale(organizationId, STALE_SCAN_AFTER);
        return this.scans.findRecent(
            organizationId,
            await this.repositoryScope(organizationId, repositoryIds),
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
        const scope = await this.repositoryScope(organizationId, repositoryIds);
        if (
            !scan ||
            scan.organizationId !== organizationId ||
            (scope &&
                !scope.some(
                    (r) =>
                        r.id === scan.repository.id &&
                        r.platform === scan.repository.platform &&
                        r.host === scan.repository.host,
                ))
        ) {
            throw new NotFoundException('Security scan not found.');
        }
        return scan;
    }
}
