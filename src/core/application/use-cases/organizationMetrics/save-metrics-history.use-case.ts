import { Inject, Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    IOrganizationMetricsService,
    ORGANIZATION_METRICS_SERVICE_TOKEN,
} from '@/core/domain/organizationMetrics/contracts/organizationMetrics.service.contract';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';

@Injectable()
export class SaveAllOrganizationMetricsHistoryUseCase {
    constructor(
        private logger: PinoLoggerService,

        @Inject(ORGANIZATION_METRICS_SERVICE_TOKEN)
        private organizationMetricsService: IOrganizationMetricsService,
    ) {}

    async execute(
        organizationId: string,
        howManyHistoricalDays?: number,
        metricsCategory?: METRICS_CATEGORY,
    ): Promise<void> {
        try {
            await this.organizationMetricsService.saveAllMetricsHistory({
                organizationId,
                howManyHistoricalDays: howManyHistoricalDays ?? 90,
                metricsCategory,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error saving metrics history for the organization',
                context: SaveAllOrganizationMetricsHistoryUseCase.name,
                serviceName: 'SaveAllOrganizationMetricsHistoryUseCase',
                error: error,
                metadata: {
                    organizationId,
                    howManyHistoricalDays,
                    metricsCategory,
                },
            });
        }
    }
}
