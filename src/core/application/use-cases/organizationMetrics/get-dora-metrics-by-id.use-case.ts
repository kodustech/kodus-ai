import { Inject, Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    IOrganizationMetricsService,
    ORGANIZATION_METRICS_SERVICE_TOKEN,
} from '@/core/domain/organizationMetrics/contracts/organizationMetrics.service.contract';
import { REQUEST } from '@nestjs/core';
import { CacheService } from '@/shared/utils/cache/cache.service';

@Injectable()
export class GetOrganizationDoraMetricsByIdUseCase {
    constructor(
        @Inject(ORGANIZATION_METRICS_SERVICE_TOKEN)
        private organizationMetricsService: IOrganizationMetricsService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private logger: PinoLoggerService,
        private readonly cacheService: CacheService,
    ) {}

    async execute(organizationId?: string) {
        try {
            const orgId = organizationId ?? this.request.user.organization.uuid;

            const cacheKey = `organization_dora_metrics_${orgId}`;
            const cachedMetrics =
                await this.cacheService.getFromCache(cacheKey);

            if (cachedMetrics) {
                return cachedMetrics;
            }

            const result =
                await this.organizationMetricsService.compareCurrentAndLastWeekDoraMetrics(
                    { organizationId: orgId },
                );

            await this.cacheService.addToCache(
                cacheKey,
                result.organizationMetrics,
                600000,
            );

            return result.organizationMetrics;
        } catch (error) {
            this.logger.error({
                message:
                    'Error while fetching dora metrics for the organization via API',
                context: GetOrganizationDoraMetricsByIdUseCase.name,
                serviceName: 'GetOrganizationMetricsByIdUseCase',
                error: error,
                metadata: {
                    organizationId: organizationId,
                },
            });
            throw error;
        }
    }
}
