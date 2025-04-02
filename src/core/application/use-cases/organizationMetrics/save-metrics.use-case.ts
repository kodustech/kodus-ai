import { Inject, Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    IOrganizationMetricsService,
    ORGANIZATION_METRICS_SERVICE_TOKEN,
} from '@/core/domain/organizationMetrics/contracts/organizationMetrics.service.contract';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';

@Injectable()
export class SaveOrganizationMetricsToDbUseCase {
    constructor(
        private logger: PinoLoggerService,

        @Inject(ORGANIZATION_METRICS_SERVICE_TOKEN)
        private organizationMetricsService: IOrganizationMetricsService,
    ) {}

    async execute(organizationId: string, metricsCategory?: METRICS_CATEGORY) {
        try {
            return await this.organizationMetricsService.runDaily(
                organizationId,
                metricsCategory,
            );
        } catch (error) {
            this.logger.error({
                message:
                    'Error calculating metrics for the organization via API',
                context: SaveOrganizationMetricsToDbUseCase.name,
                serviceName: 'SaveOrganizationMetricsToDbUseCase',
                error: error,
                metadata: {
                    organizationId: organizationId,
                },
            });
        }
    }
}
