import { CalculateMetricsUseCase } from '@/core/application/use-cases/metrics/calculate-metrics.use-case';
import { SaveFlowMetricsToDbUseCase } from '@/core/application/use-cases/metrics/save-db-flow-metrics.use-case';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { TeamQueryDto } from '../dtos/teamId-query-dto';
import { GetMetricsByTeamUseCase } from '@/core/application/use-cases/metrics/get-metrics-by-team.use-case';
import { GetMetricsByOrganizationUseCase } from '@/core/application/use-cases/metrics/get-metrics-by-organization.use-case';
import { GetTeamMetricsByIdUseCase } from '@/core/application/use-cases/metrics/get-metrics-by-id.use-case';
import { SaveDoraMetricsToDbUseCase } from '@/core/application/use-cases/metrics/save-db-dora-metrics.use-case';
import { CalculateDoraMetricsUseCase } from '@/core/application/use-cases/metrics/calculate-dora-metrics.use-case';
import { GetTeamDoraMetricsForCockPitUseCase } from '@/core/application/use-cases/metrics/get-dora-metrics-for-cockpit.use-case';
import { GetDoraMetricsByTeamUseCase } from '@/core/application/use-cases/metrics/get-dora-metrics-by-team.use-case';
import { GetDoraMetricsByOrganizationUseCase } from '@/core/application/use-cases/metrics/get-dora-metrics-by-organization.use-case';
import { SaveAllTeamMetricsHistoryUseCase } from '@/core/application/use-cases/metrics/save-all-metrics-history.use-case';
import { GetEffortTeamUseCase } from '@/core/application/use-cases/platformIntegration/projectManagement/get-team-effort.use-case';
import { NewItemsFrom } from '../../adapters/services/metrics/processMetrics/deliveryCapacity';

@Controller('metrics')
export class MetricsController {
    constructor(
        private readonly calculateDoraMetricsUseCase: CalculateDoraMetricsUseCase,
        private readonly calculateMetricsUseCase: CalculateMetricsUseCase,
        private readonly getDoraMetricsByOrganizationUseCase: GetDoraMetricsByOrganizationUseCase,
        private readonly getDoraMetricsByTeamUseCase: GetDoraMetricsByTeamUseCase,
        private readonly getMetricsByOrganizationUseCase: GetMetricsByOrganizationUseCase,
        private readonly getMetricsByTeamUseCase: GetMetricsByTeamUseCase,
        private readonly getMetricsByIdUseCase: GetTeamMetricsByIdUseCase,
        private readonly getTeamDoraMetricsForCockPitUseCase: GetTeamDoraMetricsForCockPitUseCase,
        private readonly saveAllTeamMetricsHistoryUseCase: SaveAllTeamMetricsHistoryUseCase,
        private readonly saveDoraMetricsToDbUseCase: SaveDoraMetricsToDbUseCase,
        private readonly saveFlowMetricsToDbUseCase: SaveFlowMetricsToDbUseCase,
        private readonly getEffortTeamUseCase: GetEffortTeamUseCase,
    ) {}

    @Post('/run')
    public async runAutomation(@Body() body: TeamQueryDto) {
        return await this.calculateMetricsUseCase.execute(body?.teamId);
    }

    @Post('/run-dora-metrics')
    public async runDoraMetrics(@Body() body: TeamQueryDto) {
        return await this.calculateDoraMetricsUseCase.execute(body?.teamId);
    }

    @Post('/save-history')
    public async saveHistory(@Body() body: any) {
        return await this.saveAllTeamMetricsHistoryUseCase.execute(
            body.teamId,
            body?.howManyHistoricalDays,
        );
    }

    @Post('/save')
    public async saveMetricsOnBd(@Body() body: TeamQueryDto) {
        return await this.saveFlowMetricsToDbUseCase.execute(body?.teamId);
    }

    @Post('/save-dora-metrics')
    public async saveDoraMetricsOnBd(@Body() body: TeamQueryDto) {
        return await this.saveDoraMetricsToDbUseCase.execute(body?.teamId);
    }

    @Get('/get-by-team-id')
    public async getMetricsByTeamIdAndPeriod(
        @Query('teamId') teamId: string,
        @Query('startDate') startDate: string,
        @Query('endDate') endDate: string,
        @Query('newItemsFrom') newItemsFrom: NewItemsFrom,
    ) {
        return await this.getMetricsByTeamUseCase.execute(
            teamId,
            startDate,
            endDate,
            newItemsFrom,
        );
    }

    //Fetch Flow Metrics for the charts
    @Get('/get-by-organization-id')
    public async getMetricsByOrganizationIdAndPeriod(
        @Query('organizationId') organizationId: string,
        @Query('startDate') startDate: string,
        @Query('endDate') endDate: string,
    ) {
        return await this.getMetricsByOrganizationUseCase.execute(
            organizationId,
            startDate,
            endDate,
        );
    }

    @Get('/get-cockpit-data')
    public async getMetricsById(
        @Query('teamId')
        teamId: string,
    ) {
        return await this.getMetricsByIdUseCase.execute(teamId);
    }

    @Get('/get-dora-metrics-by-team-id')
    public async getDoraMetricsByTeamIdAndPeriod(
        @Query('teamId') teamId: string,
        @Query('startDate') startDate: string,
        @Query('endDate') endDate: string,
    ) {
        return await this.getDoraMetricsByTeamUseCase.execute(
            teamId,
            startDate,
            endDate,
        );
    }

    //Fetch Dora Metrics for the charts
    @Get('/get-dora-metrics-by-organization-id')
    public async getDoraMetricsByOrganizationIdAndPeriod(
        @Query('organizationId') organizationId: string,
        @Query('startDate') startDate: string,
        @Query('endDate') endDate: string,
    ) {
        return await this.getDoraMetricsByOrganizationUseCase.execute(
            organizationId,
            startDate,
            endDate,
        );
    }

    @Get('/get-cockpit-dora-metrics')
    public async getDoraMetricsByTeamId(
        @Query('teamId')
        teamId: string,
    ) {
        return await this.getTeamDoraMetricsForCockPitUseCase.execute(teamId);
    }

    @Get('/get-team-effort')
    public async getTeamEffort(@Query('teamId') teamId: string) {
        return await this.getEffortTeamUseCase.execute(teamId);
    }
}
