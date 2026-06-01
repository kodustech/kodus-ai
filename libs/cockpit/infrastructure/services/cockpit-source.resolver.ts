import { Injectable } from '@nestjs/common';

import { COCKPIT_SOURCE, CockpitSource } from '../../domain/cockpit-source.enum';

/**
 * Resolves which backend serves cockpit reads. The legacy BigQuery path is
 * gone — every caller now uses the in-process Postgres warehouse.
 *
 * Kept as an injected service so the seam survives if we ever need to gate
 * routing again. For now it is a constant.
 */
@Injectable()
export class CockpitSourceResolver {
    async resolve(_organizationId: string): Promise<CockpitSource> {
        return COCKPIT_SOURCE.INTERNAL;
    }
}
