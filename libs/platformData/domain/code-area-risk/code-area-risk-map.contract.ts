import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import type { CodeAreaRiskMap } from './build-area-risk-map';

export const CODE_AREA_RISK_MAP_SERVICE_TOKEN = Symbol.for(
    'CodeAreaRiskMapService',
);
export const REFRESH_CODE_AREA_RISK_MAP_SERVICE_TOKEN = Symbol.for(
    'RefreshCodeAreaRiskMapService',
);

export interface ICodeAreaRiskMapService {
    read(
        organizationId: string,
        repositoryId: string,
    ): Promise<CodeAreaRiskMap | null>;
    save(
        organizationId: string,
        repositoryId: string,
        snapshot: CodeAreaRiskMap,
    ): Promise<void>;
}

export interface CodeAreaHistorySyncStatus {
    source: string;
    windowStart: string;
    windowEnd: string;
    cursorEnd: string;
    discoveredMergedPrs: number;
    complete: boolean;
    /** The provider could not list this repository's PRs; skip it until then. */
    retryAfter?: string | null;
}

/**
 * The provider could not list the repository's PRs (App uninstalled or
 * suspended, repository gone). `attempt` counts consecutive failed runs, so a
 * scheduler can report the first one and stay quiet on the retries.
 */
export class CodeAreaHistoryUnavailableError extends Error {
    constructor(
        readonly attempt: number,
        readonly retryAfter: string,
    ) {
        super('Could not list PR history for area map');
    }
}

export interface IRefreshCodeAreaRiskMapService {
    readStatus(
        organizationId: string,
        repositoryId: string,
    ): Promise<CodeAreaHistorySyncStatus | null>;
    refreshOneBatch(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
    }): Promise<{
        complete: boolean;
        processed: number;
        /** Some PR in the batch could not be read; the cursor moved past it. */
        failed: boolean;
        cursorEnd: string;
    }>;
}
