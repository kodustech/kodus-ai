import { STATUS } from '@/config/types/database/status.type';
import {
    DORA_METRICS_FACTORY_TOKEN,
    IDoraMetricsFactory,
} from '@/core/domain/metrics/contracts/doraMetrics.factory.contract';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import {
    IMetricsService,
    METRICS_SERVICE_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.service.contract';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';
import {
    IOrganizationMetricsRepository,
    ORGANIZATION_METRICS_REPOSITORY_TOKEN,
} from '@/core/domain/organizationMetrics/contracts/organizationMetrics.repository.contract';
import { IOrganizationMetricsService } from '@/core/domain/organizationMetrics/contracts/organizationMetrics.service.contract';
import { OrganizationMetricsEntity } from '@/core/domain/organizationMetrics/entities/organizationMetrics.entity';
import { IOrganizationMetrics } from '@/core/domain/organizationMetrics/interfaces/organizationMetrics.interface';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { MetricsConversionStructure } from '@/shared/domain/interfaces/metrics';
import {
    getMetricPropertyByType,
    processAndAppendPlatformConnected,
} from '@/shared/infrastructure/services/metrics';
import { CacheService } from '@/shared/utils/cache/cache.service';
import { LeadTimeFormat } from '@/shared/utils/formatters/leadTime';
import { LeadTimeForChangeFormat } from '@/shared/utils/formatters/leadTimeForChange';
import { getDayForFilter } from '@/shared/utils/transforms/date';
import { Inject, Injectable } from '@nestjs/common';
import { FindOneOptions } from 'typeorm';
import { ValidateCodeManagementIntegration } from '@/shared/utils/decorators/validate-code-management-integration.decorator';
import { ValidateProjectManagementIntegration } from '@/shared/utils/decorators/validate-project-management-integration.decorator';

import {
    IntegrationMatchType,
    IntegrationStatusFilter,
    ITeamWithIntegrations,
} from '@/core/domain/team/interfaces/team.interface';
import { PinoLoggerService } from './logger/pino.service';
import { OrganizationMetricsModel } from '../repositories/typeorm/schema/organizationMetrics.model';
import { BugRatioCalculator } from './metrics/processMetrics/bugRatio';
import { DeployFrequencyCalculator } from './metrics/processMetrics/doraMetrics/deployFrequency';
import { LeadTimeForChangeCalculator } from './metrics/processMetrics/doraMetrics/leadTimeForChange';
import { LeadTimeCalculator } from './metrics/processMetrics/leadTime';
import { LeadTimeInWipCalculator } from './metrics/processMetrics/leadTimeInWip';
import { ThroughputCalculator } from './metrics/processMetrics/throughput';
import { CodeManagementService } from './platformIntegration/codeManagement.service';
import { ProjectManagementService } from './platformIntegration/projectManagement.service';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';

@Injectable()
export class OrganizationMetricsService implements IOrganizationMetricsService {
    constructor(
        @Inject(ORGANIZATION_METRICS_REPOSITORY_TOKEN)
        private readonly organizationMetricsRepository: IOrganizationMetricsRepository,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,

        @Inject(DORA_METRICS_FACTORY_TOKEN)
        private readonly doraMetricsFactory: IDoraMetricsFactory,

        @Inject(METRICS_SERVICE_TOKEN)
        private readonly metricsService: IMetricsService,

        private readonly codeManagementService: CodeManagementService,

        private readonly projectManagementService: ProjectManagementService,

        private readonly logger: PinoLoggerService,

        private readonly cacheService: CacheService,
    ) {}

    //#region Find Methods
    find(
        filter: Partial<IOrganizationMetrics>,
    ): Promise<OrganizationMetricsEntity[]> {
        return this.organizationMetricsRepository.find(filter);
    }

    findOne(
        where: FindOneOptions<OrganizationMetricsModel>,
    ): Promise<OrganizationMetricsEntity> {
        return this.organizationMetricsRepository.findOne(where);
    }

    findById(uuid: string): Promise<OrganizationMetricsEntity> {
        return this.organizationMetricsRepository.findById(uuid);
    }

    findLastSavedMetricsByOrganizationIdAndWeeks(
        organizationId: string,
        howManyWeeks: number,
    ): Promise<OrganizationMetricsEntity[]> {
        throw new Error('Method not implemented.');
    }
    //#endregion

    //#region Write Methods
    create(
        metricsEntity: IOrganizationMetrics,
    ): Promise<OrganizationMetricsEntity> {
        return this.organizationMetricsRepository.create(metricsEntity);
    }

    public async bulkCreate(
        metricsEntity: IOrganizationMetrics[],
    ): Promise<OrganizationMetricsEntity[]> {
        return await this.organizationMetricsRepository.bulkCreate(
            metricsEntity,
        );
    }

    delete(organizationId: string): Promise<void> {
        return this.organizationMetricsRepository.delete(organizationId);
    }
    //#endregion

    //#region Metrics History
    public async saveAllMetricsHistory(params: {
        organizationId: string;
        howManyHistoricalDays: number;
        metricsCategory?: METRICS_CATEGORY;
        teamStatus?: STATUS;
    }): Promise<void> {
        try {
            if (!params.teamStatus) {
                params.teamStatus = STATUS.ACTIVE;
            }

            const {
                organizationId,
                howManyHistoricalDays,
                metricsCategory,
                teamStatus,
            } = params;
            // Configure the period
            const endDate = new Date();
            const startDate = new Date(endDate);
            startDate.setDate(startDate.getDate() - howManyHistoricalDays);

            // Fetch teams with configured integrations
            const teams = await this.teamService.findTeamsWithIntegrations({
                organizationId,
                status: teamStatus,
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
            });

            if (!teams || teams.length === 0) {
                return;
            }

            // Separate teams by type of integration
            const teamsWithCodeManagement = teams.filter(
                (team) => team.isCodeManagementConfigured,
            );
            const teamsWithProjectManagement = teams.filter(
                (team) => team.isProjectManagementConfigured,
            );

            let consolidatedFlowMetrics: IOrganizationMetrics[] = [];
            let consolidatedDoraMetrics: IOrganizationMetrics[] = [];

            // Process DORA Metrics (requires integration with Code Management)
            if (
                teamsWithCodeManagement?.length > 0 &&
                (metricsCategory === METRICS_CATEGORY.DORA_METRICS ||
                    metricsCategory === undefined)
            ) {
                consolidatedDoraMetrics =
                    await this.processDoraMetricsForPeriod(
                        organizationId,
                        teamsWithCodeManagement,
                        startDate,
                        endDate,
                    );

                if (consolidatedDoraMetrics?.length > 0) {
                    await this.saveMetrics(
                        organizationId,
                        consolidatedDoraMetrics,
                        METRICS_CATEGORY.DORA_METRICS,
                    );
                }
            }

            // Processes Flow Metrics (requires integration with Project Management)
            if (
                teamsWithProjectManagement?.length > 0 &&
                (metricsCategory === METRICS_CATEGORY.FLOW_METRICS ||
                    metricsCategory === undefined)
            ) {
                consolidatedFlowMetrics =
                    await this.processFlowMetricsForPeriod(
                        organizationId,
                        teamsWithProjectManagement,
                        startDate,
                        endDate,
                    );

                if (consolidatedFlowMetrics?.length > 0) {
                    await this.saveMetrics(
                        organizationId,
                        consolidatedFlowMetrics,
                        METRICS_CATEGORY.FLOW_METRICS,
                    );
                }
            }

            // Clears the cache
            await this.clearMetricsCache(organizationId);
        } catch (error) {
            this.logger.error({
                message: 'Error saving metrics history for the organization',
                context: OrganizationMetricsService.name,
                error: error,
                metadata: {
                    organizationId: params?.organizationId,
                },
            });
            throw error;
        }
    }

    // Helper method to save metrics
    private async saveMetrics(
        organizationId: string,
        metrics: IOrganizationMetrics[],
        category: METRICS_CATEGORY,
    ): Promise<void> {
        try {
            await this.organizationMetricsRepository.delete(
                organizationId,
                category,
            );
            await this.organizationMetricsRepository.bulkCreate(metrics);
        } catch (error) {
            this.logger.error({
                message: `Error saving ${category} history for the organization`,
                context: OrganizationMetricsService.name,
                error,
                metadata: { organizationId },
            });
            throw error;
        }
    }

    // Helper method to clear cache
    private async clearMetricsCache(organizationId: string): Promise<void> {
        await this.cacheService.removeFromCache(
            `organization_dora_metrics_${organizationId}`,
        );
        await this.cacheService.removeFromCache(
            `organization_metrics_${organizationId}`,
        );
    }

    private async processDoraMetricsForPeriod(
        organizationId: string,
        teams: ITeamWithIntegrations[],
        startDate: Date,
        endDate: Date,
    ): Promise<IOrganizationMetrics[]> {
        const consolidatedDoraMetrics: IOrganizationMetrics[] = [];

        for (
            let currentDate = new Date(startDate);
            currentDate < endDate;
            currentDate.setDate(currentDate.getDate() + 1)
        ) {
            const dailyTeamMetrics: IOrganizationMetrics[] = [];

            // Collect metrics from all teams for the current day
            for (const team of teams) {
                const teamMetrics =
                    await this.metricsService.getTeamMetricsByPeriod(
                        team.uuid,
                        1,
                        currentDate,
                    );
                dailyTeamMetrics.push(...teamMetrics);
            }

            if (dailyTeamMetrics.length > 0) {
                const consolidatedDailyMetrics =
                    this.calculateCompanyDoraMetrics(dailyTeamMetrics);

                // Transform the consolidated metrics into the required format
                consolidatedDailyMetrics.forEach((metric) => {
                    consolidatedDoraMetrics.push({
                        organization: { uuid: organizationId },
                        type: metric.type,
                        value: metric.value,
                        status: true,
                        referenceDate: currentDate.toISOString(),
                        category: METRICS_CATEGORY.DORA_METRICS,
                    });
                });
            }
        }
        return consolidatedDoraMetrics;
    }

    private async processFlowMetricsForPeriod(
        organizationId: string,
        teams: ITeamWithIntegrations[],
        startDate: Date,
        endDate: Date,
    ): Promise<IOrganizationMetrics[]> {
        const consolidatedFlowMetrics: IOrganizationMetrics[] = [];

        for (
            let currentDate = new Date(startDate);
            currentDate < endDate;
            currentDate.setDate(currentDate.getDate() + 1)
        ) {
            const dailyTeamMetrics: IOrganizationMetrics[] = [];

            // Collect metrics from all teams for the current day
            for (const team of teams) {
                const teamMetrics =
                    await this.metricsService.getTeamMetricsByPeriod(
                        team.uuid,
                        1,
                        currentDate,
                    );
                dailyTeamMetrics.push(...teamMetrics);
            }

            if (dailyTeamMetrics.length > 0) {
                const consolidatedDailyMetrics =
                    this.calculateCompanyFlowMetrics(dailyTeamMetrics);

                // Transform the consolidated metrics into the required format
                consolidatedDailyMetrics.forEach((metric) => {
                    consolidatedFlowMetrics.push({
                        organization: { uuid: organizationId },
                        type: metric.type,
                        value: metric.value,
                        status: true,
                        referenceDate: currentDate.toISOString(),
                        category: METRICS_CATEGORY.FLOW_METRICS,
                    });
                });
            }
        }

        return consolidatedFlowMetrics;
    }
    //#endregion

    public async runDaily(
        organizationId: string,
        metricCategory?: METRICS_CATEGORY,
    ): Promise<any> {
        try {
            if (
                !metricCategory ||
                metricCategory === METRICS_CATEGORY.FLOW_METRICS
            ) {
                const metrics =
                    await this.calculateRealTimeFlowMetricsForCompany(
                        organizationId,
                    );

                await this.processMetricsAndSave(
                    metrics,
                    organizationId,
                    METRICS_CATEGORY.FLOW_METRICS,
                );
            }

            if (
                !metricCategory ||
                metricCategory === METRICS_CATEGORY.DORA_METRICS
            ) {
                const { realTimeDoraMetrics } =
                    await this.calculateRealTimeDoraMetricsForCompany(
                        organizationId,
                    );

                await this.processMetricsAndSave(
                    realTimeDoraMetrics,
                    organizationId,
                    METRICS_CATEGORY.DORA_METRICS,
                );
            }

            return 'ok';
        } catch (error) {
            console.log(error);
            throw error;
        }
    }

    private async processMetricsAndSave(
        metrics,
        organizationId: string,
        category: METRICS_CATEGORY,
    ) {
        for (const metric of metrics) {
            if (!metric || metric.value === null || metric.value === undefined)
                continue;

            await this.create({
                organization: { uuid: organizationId },
                type: metric.type,
                value: metric.value,
                status: true,
                category: category,
            });
        }
    }
    //#endregion

    //#region Dora Metrics
    public async calculateRealTimeDoraMetricsForCompany(
        organizationId: string,
    ): Promise<any> {
        const teamsMetric: IOrganizationMetrics[] = [];
        let teamsCodeManagementConfig = [];

        const teams = await this.teamService.findTeamsWithIntegrations({
            organizationId,
            status: STATUS.ACTIVE,
            integrationCategories: [IntegrationCategory.CODE_MANAGEMENT],
            integrationStatus: IntegrationStatusFilter.CONFIGURED,
            matchType: IntegrationMatchType.EVERY,
        });

        const metricsConfig = {
            howManyMetricsInThePast: 0,
            daysInterval: 7,
            weekDay: new Date().getDay(),
        };

        for (const team of teams) {
            const teamMetrics =
                await this.doraMetricsFactory.getDoraMetricsHistoryWithConfigurableParams(
                    {
                        organizationId: organizationId,
                        teamId: team.uuid,
                    },
                    MetricsConversionStructure.I_METRICS,
                    metricsConfig,
                );

            if (teamMetrics && !('hasConnection' in teamMetrics)) {
                if (Array.isArray(teamMetrics) && teamMetrics.length > 0) {
                    teamsMetric.push(...teamMetrics);
                }
            } else if (teamMetrics && 'hasConnection' in teamMetrics) {
                processAndAppendPlatformConnected(
                    teamsCodeManagementConfig,
                    team,
                    teamMetrics,
                );
            }
        }

        const realTimeDoraMetrics =
            await this.calculateCompanyDoraMetrics(teamsMetric);

        return { realTimeDoraMetrics, teamsCodeManagementConfig };
    }

    @ValidateCodeManagementIntegration({
        allowPartialTeamConnection: true,
    })
    public async compareCurrentAndLastWeekDoraMetrics(params: {
        organizationId: string;
    }): Promise<any> {
        const rawData =
            await this.organizationMetricsRepository.findLastSavedMetricsByOrganizationIdAndWeeks(
                params.organizationId,
                2,
                METRICS_CATEGORY.DORA_METRICS,
            );

        // Separate current and historical metrics
        const currentMetrics = new Map();
        const historicalMetrics = new Map();

        rawData.forEach((metric) => {
            if (metric.category !== METRICS_CATEGORY.DORA_METRICS) {
                return;
            }

            const key = metric.type;
            if (
                !currentMetrics.has(key) ||
                new Date(metric.referenceDate) >
                    new Date(currentMetrics.get(key)._referenceDate)
            ) {
                currentMetrics.set(key, metric);
            } else if (
                !historicalMetrics.has(key) ||
                new Date(metric.referenceDate) >
                    new Date(historicalMetrics.get(key)._referenceDate)
            ) {
                historicalMetrics.set(key, metric);
            }
        });

        const organizationMetrics = Array.from(currentMetrics.values()).map(
            (currentMetric) => {
                const historicalMetric = historicalMetrics.get(
                    currentMetric._type,
                );

                let difference = '';
                let resultType = '';
                let howToAnalyze = '';
                let whatIsIt = '';
                let title = '';
                let result = '';
                let resultObs = '';
                let layoutIndex = 0;

                switch (currentMetric._type) {
                    case 'deployFrequency':
                        title = 'Deploy Frequency';
                        result = currentMetric._value ?? 0;
                        resultObs = 'deploys/week';
                        layoutIndex = 1;
                        break;
                    case 'leadTimeForChange':
                        title = 'Lead Time For Change';
                        result = LeadTimeForChangeFormat(currentMetric._value);
                        layoutIndex = 2;
                        break;
                    default:
                        title = currentMetric._type;
                }

                howToAnalyze = getMetricPropertyByType(
                    currentMetric._type,
                    'explanationForOrganizations',
                );
                whatIsIt = getMetricPropertyByType(
                    currentMetric._type,
                    'whatIsIt',
                );

                if (historicalMetric) {
                    let change;
                    difference = '0%';
                    resultType = 'Same';
                    const currentValue =
                        currentMetric._type === METRICS_TYPE.DEPLOY_FREQUENCY
                            ? currentMetric._value
                            : currentMetric._value;
                    const historicalValue =
                        historicalMetric._type === METRICS_TYPE.DEPLOY_FREQUENCY
                            ? historicalMetric._value
                            : historicalMetric._value;

                    if (historicalValue === 0 && currentValue !== 0) {
                        change = 100;
                    } else if (historicalValue === 0 && currentValue === 0) {
                        change = 0;
                    } else {
                        change =
                            ((currentValue - historicalValue) /
                                historicalValue) *
                            100;
                    }
                    difference = `${Math.abs(parseFloat(change.toFixed(2)))}%`;

                    if (change < 0) {
                        resultType = 'Negative';
                    } else if (change > 0) {
                        resultType = 'Positive';
                    }
                }

                return {
                    name: currentMetric._type,
                    title: title,
                    result,
                    resultType,
                    resultObs: resultObs.trim() !== '' ? resultObs : undefined,
                    difference,
                    howToAnalyze,
                    whatIsIt,
                    layoutIndex,
                };
            },
        );

        return { organizationMetrics };
    }

    private calculateCompanyDoraMetrics(
        metrics: IOrganizationMetrics[],
    ): { type: METRICS_TYPE; value: any; referenceDate: string }[] {
        const { today, dateAfterDaysInformed } = getDayForFilter(90);

        const deployFrequencyCalculator = new DeployFrequencyCalculator();
        deployFrequencyCalculator.setConfiguration({
            analysisPeriod: {
                startTime: new Date(dateAfterDaysInformed),
                endTime: new Date(today),
            },
        });
        const leadTimeForChangeCalculator = new LeadTimeForChangeCalculator();

        const deployFrequency =
            deployFrequencyCalculator.calculateAverageWeeklyFrequencyCompanyDeployFrequency(
                metrics.filter(
                    (metric) => metric.type === METRICS_TYPE.DEPLOY_FREQUENCY,
                ),
            );

        const leadTimeForChange =
            leadTimeForChangeCalculator.calculateAverageCompanyLeadTimeForChange(
                metrics.filter(
                    (metric) =>
                        metric.type === METRICS_TYPE.LEAD_TIME_FOR_CHANGE,
                ),
            );

        return [
            {
                type: METRICS_TYPE.DEPLOY_FREQUENCY,
                value: deployFrequency,
                referenceDate: today.toString(),
            },
            {
                type: METRICS_TYPE.LEAD_TIME_FOR_CHANGE,
                value: leadTimeForChange,
                referenceDate: today.toString(),
            },
        ];
    }
    // #endregion

    // #region Flow Metrics
    public async calculateRealTimeFlowMetricsForCompany(
        organizationId: string,
    ): Promise<{ type: METRICS_TYPE; value: any }[]> {
        const teams = await this.teamService.findTeamsWithIntegrations({
            organizationId,
            status: STATUS.ACTIVE,
            integrationCategories: [IntegrationCategory.PROJECT_MANAGEMENT],
            integrationStatus: IntegrationStatusFilter.CONFIGURED,
            matchType: IntegrationMatchType.EVERY,
        });

        const teamsMetric: IOrganizationMetrics[] = [];

        if (!teams || teams?.length <= 0) {
            return;
        }

        const metricsConfig = {
            howManyMetricsInThePast: 0,
            daysInterval: 7,
            weekDay: new Date().getDay(),
        };

        for (const team of teams) {
            const teamMetrics =
                await this.metricsFactory.getFlowMetricsHistoryWithConfigurableParams(
                    {
                        organizationId: organizationId,
                        teamId: team.uuid,
                    },
                    MetricsConversionStructure.I_METRICS,
                    metricsConfig,
                );

            if (teamMetrics && teamMetrics.length > 0)
                teamsMetric.push(...teamMetrics);
        }

        return await this.calculateCompanyFlowMetrics(teamsMetric);
    }

    @ValidateProjectManagementIntegration({
        allowPartialTeamConnection: true,
    })
    public async compareCurrentAndLastWeekFlowMetrics(params: {
        organizationId: string;
    }): Promise<any> {
        const rawData =
            await this.organizationMetricsRepository.findLastSavedMetricsByOrganizationIdAndWeeks(
                params.organizationId,
                1,
                METRICS_CATEGORY.FLOW_METRICS,
            );

        const currentMetrics = new Map();
        const historicalMetrics = new Map();

        rawData.forEach((metric) => {
            const key = metric.type;

            if (
                !currentMetrics.has(key) ||
                new Date(metric.referenceDate) >
                    new Date(currentMetrics.get(key)._referenceDate)
            ) {
                if (currentMetrics.has(key)) {
                    historicalMetrics.set(key, currentMetrics.get(key));
                }
                currentMetrics.set(key, metric);
            } else if (
                !historicalMetrics.has(key) ||
                new Date(metric.referenceDate) >
                    new Date(historicalMetrics.get(key)._referenceDate)
            ) {
                historicalMetrics.set(key, metric);
            }
        });

        const organizationMetrics = Array.from(currentMetrics.values()).map(
            (currentMetric) => {
                const historicalMetric = historicalMetrics.get(
                    currentMetric._type,
                );

                let difference = '';
                let resultType = '';
                let howToAnalyze = '';
                let whatIsIt = '';
                let title = '';
                let result = '';
                let resultObs = '';
                let layoutIndex = 0;

                switch (currentMetric._type) {
                    case METRICS_TYPE.LEAD_TIME:
                    case METRICS_TYPE.LEAD_TIME_IN_WIP:
                        title =
                            currentMetric._type === METRICS_TYPE.LEAD_TIME
                                ? 'Lead Time'
                                : 'Lead Time in WIP';
                        result = LeadTimeFormat(currentMetric._value);
                        layoutIndex =
                            currentMetric._type ===
                            METRICS_TYPE.LEAD_TIME_IN_WIP
                                ? 1
                                : 4;
                        break;
                    case METRICS_TYPE.BUG_RATIO:
                        title = 'Bug Ratio';
                        result = `${!isNaN(currentMetric._value) ? currentMetric._value.toFixed(2).toString() : '0'}%`;
                        layoutIndex = 3;
                        break;
                    case METRICS_TYPE.THROUGHPUT:
                        title = 'Throughput';
                        result = `${!isNaN(currentMetric._value) ? currentMetric._value.toString() : '0'}`;
                        resultObs =
                            currentMetric._value === 1
                                ? 'Delivered item'
                                : 'Delivered items';
                        layoutIndex = 2;
                        break;
                    default:
                        title = currentMetric._type;
                }

                howToAnalyze = getMetricPropertyByType(
                    currentMetric._type,
                    'explanationForOrganizations',
                );
                whatIsIt = getMetricPropertyByType(
                    currentMetric._type,
                    'whatIsIt',
                );

                if (historicalMetric) {
                    let change;
                    difference = '0%';
                    resultType = 'Same';
                    if (
                        historicalMetric._value === 0 &&
                        currentMetric._value !== 0
                    ) {
                        change = 100;
                    } else if (
                        historicalMetric._value === 0 &&
                        currentMetric._value === 0
                    ) {
                        change = 0;
                    } else {
                        change =
                            ((currentMetric._value - historicalMetric._value) /
                                historicalMetric._value) *
                            100;
                    }
                    difference = `${Math.abs(parseFloat(change.toFixed(2)))}%`;

                    if (
                        (currentMetric._type === METRICS_TYPE.THROUGHPUT &&
                            change > 0) ||
                        (currentMetric._type !== METRICS_TYPE.THROUGHPUT &&
                            change < 0)
                    ) {
                        resultType = 'Positive';
                    } else if (
                        (currentMetric._type === METRICS_TYPE.THROUGHPUT &&
                            change < 0) ||
                        (currentMetric._type !== METRICS_TYPE.THROUGHPUT &&
                            change > 0)
                    ) {
                        resultType = 'Negative';
                    }
                }

                return {
                    name: currentMetric._type,
                    title: title,
                    result: result.trim(),
                    resultType,
                    difference,
                    howToAnalyze,
                    whatIsIt,
                    resultObs: resultObs.trim() !== '' ? resultObs : undefined,
                    layoutIndex,
                };
            },
        );

        return organizationMetrics;
    }

    private calculateCompanyFlowMetrics(
        metrics: IOrganizationMetrics[],
    ): { type: METRICS_TYPE; value: any }[] {
        const leadTimeCalculator = new LeadTimeCalculator();
        const leadTimeInWipCalculator = new LeadTimeInWipCalculator();
        const throughputCalculator = new ThroughputCalculator();
        const bugRatioCalculator = new BugRatioCalculator();

        const leadTime = leadTimeCalculator.calculateAverageCompanyLeadTime(
            metrics.filter((metric) => metric.type === METRICS_TYPE.LEAD_TIME),
        );

        const leadTimeInWip =
            leadTimeInWipCalculator.calculateAverageCompanyLeadTimeInWip(
                metrics.filter(
                    (metric) => metric.type === METRICS_TYPE.LEAD_TIME_IN_WIP,
                ),
            );

        const throughput =
            throughputCalculator.calculateAverageCompanyThroughput(
                metrics.filter(
                    (metric) => metric.type === METRICS_TYPE.THROUGHPUT,
                ),
            );

        const bugRatio = bugRatioCalculator.calculateAverageCompanyBugRatio(
            metrics.filter((metric) => metric.type === METRICS_TYPE.BUG_RATIO),
        );

        return [
            {
                type: METRICS_TYPE.LEAD_TIME,
                value: leadTime,
            },
            {
                type: METRICS_TYPE.LEAD_TIME_IN_WIP,
                value: leadTimeInWip,
            },
            {
                type: METRICS_TYPE.THROUGHPUT,
                value: throughput,
            },
            {
                type: METRICS_TYPE.BUG_RATIO,
                value: bugRatio,
            },
        ];
    }
    // #endregion
}
