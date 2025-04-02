import { Inject, Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    IOrganizationMetricsService,
    ORGANIZATION_METRICS_SERVICE_TOKEN,
} from '@/core/domain/organizationMetrics/contracts/organizationMetrics.service.contract';

@Injectable()
export class CalculateOrganizationMetricsUseCase {
    constructor(
        private logger: PinoLoggerService,

        @Inject(ORGANIZATION_METRICS_SERVICE_TOKEN)
        private organizationMetricsService: IOrganizationMetricsService,
    ) {}

    async execute(organizationId: string) {
        try {
            return await this.organizationMetricsService.calculateRealTimeFlowMetricsForCompany(
                organizationId,
            );
        } catch (error) {
            this.logger.error({
                message:
                    'Error calculating metrics for the organization via API',
                context: CalculateOrganizationMetricsUseCase.name,
                serviceName: 'CalculateOrganizationMetricsUseCase',
                error: error,
                metadata: {
                    organizationId: organizationId,
                },
            });
        }
    }
}
