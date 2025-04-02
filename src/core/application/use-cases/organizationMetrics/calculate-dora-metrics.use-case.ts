import { Inject, Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    IOrganizationMetricsService,
    ORGANIZATION_METRICS_SERVICE_TOKEN,
} from '@/core/domain/organizationMetrics/contracts/organizationMetrics.service.contract';

@Injectable()
export class CalculateOrganizationDoraMetricsUseCase {
    constructor(
        private logger: PinoLoggerService,

        @Inject(ORGANIZATION_METRICS_SERVICE_TOKEN)
        private organizationMetricsService: IOrganizationMetricsService,
    ) {}

    async execute(organizationId: string) {
        try {
            return await this.organizationMetricsService.calculateRealTimeDoraMetricsForCompany(
                organizationId,
            );
        } catch (error) {
            this.logger.error({
                message:
                    'Error calculating dora metrics for the organization via API',
                context: CalculateOrganizationDoraMetricsUseCase.name,
                serviceName: 'CalculateOrganizationMetricsUseCase',
                error: error,
                metadata: {
                    organizationId: organizationId,
                },
            });
        }
    }
}
