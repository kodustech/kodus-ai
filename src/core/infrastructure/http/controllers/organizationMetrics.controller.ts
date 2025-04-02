import { CalculateOrganizationDoraMetricsUseCase } from '@/core/application/use-cases/organizationMetrics/calculate-dora-metrics.use-case';
import { CalculateOrganizationMetricsUseCase } from '@/core/application/use-cases/organizationMetrics/calculate-metrics.use-case';
import { GetOrganizationDoraMetricsByIdUseCase } from '@/core/application/use-cases/organizationMetrics/get-dora-metrics-by-id.use-case';
import { GetOrganizationMetricsByIdUseCase } from '@/core/application/use-cases/organizationMetrics/get-metrics-by-id.use-case';
import { SaveAllOrganizationMetricsHistoryUseCase } from '@/core/application/use-cases/organizationMetrics/save-metrics-history.use-case';
import { SaveOrganizationMetricsToDbUseCase } from '@/core/application/use-cases/organizationMetrics/save-metrics.use-case';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';

@Controller('organization-metrics')
export class OrganizationMetricsController {
    constructor(
        private readonly calculateOrganizationMetricsUseCase: CalculateOrganizationMetricsUseCase,
        private readonly saveOrganizationMetricsToDbUseCase: SaveOrganizationMetricsToDbUseCase,
        private readonly getOrganizationMetricsByIdUseCase: GetOrganizationMetricsByIdUseCase,

        private readonly getOrganizationDoraMetricsByIdUseCase: GetOrganizationDoraMetricsByIdUseCase,
        private readonly calculateOrganizationDoraMetricsUseCase: CalculateOrganizationDoraMetricsUseCase,
        private readonly saveAllOrganizationMetricsHistoryUseCase: SaveAllOrganizationMetricsHistoryUseCase,
    ) {}

    @Post('/calculate')
    public async runAutomation(@Body() body: { organizationId: string }) {
        return await this.calculateOrganizationMetricsUseCase.execute(
            body?.organizationId,
        );
    }

    @Post('/save')
    public async saveMetricsOnBd(@Body() body: { organizationId: string }) {
        return await this.saveOrganizationMetricsToDbUseCase.execute(
            body?.organizationId,
        );
    }

    @Post('/save-history')
    public async saveHistory(@Body() body: any) {
        return await this.saveAllOrganizationMetricsHistoryUseCase.execute(
            body.organizationId,
            body?.howManyHistoricalDays,
        );
    }

    @Get('/get-cockpit-data')
    public async getMetricsById(
        @Query('organizationId')
        organizationId: string,
    ) {
        return await this.getOrganizationMetricsByIdUseCase.execute(
            organizationId,
        );
    }

    @Get('/get-cockpit-dora-metrics')
    public async getDoraMetricsById(
        @Query('organizationId')
        organizationId: string,
    ) {
        return await this.getOrganizationDoraMetricsByIdUseCase.execute(
            organizationId,
        );
    }

    @Post('/calculate-dora')
    public async runDoraMetrics(@Body() body: { organizationId: string }) {
        return await this.calculateOrganizationDoraMetricsUseCase.execute(
            body?.organizationId,
        );
    }
}
