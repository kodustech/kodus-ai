import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ANALYTICS_DATA_SOURCE } from '@libs/ee/analytics-warehouse';

import { CockpitValidation } from '../../domain/types';

@Injectable()
export class CockpitValidationService {
    constructor(
        @InjectDataSource(ANALYTICS_DATA_SOURCE)
        private readonly ds: DataSource,
    ) {}

    async validate(organizationId: string): Promise<CockpitValidation> {
        const rows = (await this.ds.query(
            `SELECT COUNT(*)::int AS count FROM (
                SELECT 1
                FROM "analytics"."pull_requests_opt"
                WHERE "organizationId" = $1
                LIMIT 50
             ) sub`,
            [organizationId],
        )) as Array<{ count: number }>;

        const pullRequestsCount = rows[0]?.count ?? 0;
        return {
            hasData: pullRequestsCount > 0,
            pullRequestsCount,
        };
    }
}
