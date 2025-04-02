import {
    DoraMetricsConfig,
    IDoraMetricsFactory,
} from '@/core/domain/metrics/contracts/doraMetrics.factory.contract';
import { PinoLoggerService } from '../../../logger/pino.service';
import {
    IMetricsService,
    METRICS_SERVICE_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.service.contract';
import { Inject, Injectable } from '@nestjs/common';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IMetrics } from '@/core/domain/metrics/interfaces/metrics.interface';
import {
    DoraMetricsResults,
    MetricsConversionStructure,
    TeamMetricsConfig,
} from '@/shared/domain/interfaces/metrics';
import { CodeManagementService } from '../../../platformIntegration/codeManagement.service';
import { DeployFrequencyCalculator } from './deployFrequency';
import { getDayForFilter } from '@/shared/utils/transforms/date';
import { v4 as uuidv4 } from 'uuid';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { LeadTimeForChangeCalculator } from './leadTimeForChange';
import { DeployFrequencyHistory } from '../../saveHistory/doraMetrics/deployFrequency';
import { LeadTimeForChangeHistory } from '../../saveHistory/doraMetrics/leadTimeForChange';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';
import { mergeConfig } from '@/shared/utils/helpers';
import { ValidateCodeManagementIntegration } from '@/shared/utils/decorators/validate-code-management-integration.decorator';
import { VerifyConnectionType } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';

@Injectable()
export class DoraMetricsFactory implements IDoraMetricsFactory {
    private analysisPeriodDefault = {
        startTime: new Date(),
        endTime: new Date(),
    };

    constructor(
        @Inject(METRICS_SERVICE_TOKEN)
        private readonly metricsService: IMetricsService,

        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        private readonly codeManagementService: CodeManagementService,

        private logger: PinoLoggerService,
    ) {
        this.initializeConfig();
    }

    @ValidateCodeManagementIntegration()
    async runDaily(
        organizationAndTeamData: OrganizationAndTeamData,
        doraMetricsConfig?: Partial<DoraMetricsConfig>,
    ) {
        try {
            doraMetricsConfig = {
                ...doraMetricsConfig,
                analysisPeriod:
                    doraMetricsConfig?.analysisPeriod ??
                    this.analysisPeriodDefault,
            };

            const doraMetricsResult = await this.calculateAll(
                organizationAndTeamData,
                doraMetricsConfig,
            );

            if (!doraMetricsResult) {
                return;
            }

            const metrics = this.createDoraMetricsToSave(
                doraMetricsResult,
                organizationAndTeamData.teamId,
            );

            metrics.forEach((metric) => {
                this.metricsService.create(metric);
            });
        } catch (error) {
            this.logger.error({
                message: 'Error while calculating the Dora Metrics',
                context: DoraMetricsFactory.name,
                error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            throw error;
        }
    }

    @ValidateCodeManagementIntegration()
    async getRealTime(
        organizationAndTeamData: OrganizationAndTeamData,
        doraMetricsConfig?: Partial<DoraMetricsConfig>,
        integrationStatus?: VerifyConnectionType,
    ): Promise<IMetrics[] | {}> {
        try {
            if (
                !integrationStatus?.hasConnection ||
                !integrationStatus?.isSetupComplete
            ) {
                return integrationStatus;
            }

            if (!doraMetricsConfig) {
                const yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);
                doraMetricsConfig = {
                    analysisPeriod: {
                        startTime: yesterday,
                        endTime: yesterday,
                    },
                };
            }

            const lastMetrics =
                await this.metricsService.findLastSavedMetricsToMetricsResults(
                    organizationAndTeamData.teamId,
                    doraMetricsConfig,
                );

            if (!lastMetrics?.doraMetrics) {
                return null;
            }

            const doraMetricsResult: DoraMetricsResults =
                lastMetrics.doraMetrics;

            return this.createDoraMetricsToSave(
                doraMetricsResult,
                organizationAndTeamData.teamId,
            );
        } catch (error) {
            throw error;
        }
    }

    @ValidateCodeManagementIntegration()
    private async calculateAll(
        organizationAndTeamData: OrganizationAndTeamData,
        doraMetricsConfig?: Partial<DoraMetricsConfig>,
    ): Promise<DoraMetricsResults> {
        try {
            const deployFrequencyData = [];
            // await this.codeManagementService.getDataForCalculateDeployFrequency(
            //     { organizationAndTeamData, doraMetricsConfig },
            // );

            const commitLeadTimeForChangeData =
                await this.codeManagementService.getCommitsByReleaseMode({
                    organizationAndTeamData,
                    doraMetricsConfig,
                    deployFrequencyData,
                });

            const deployFrequencyCalculator = new DeployFrequencyCalculator();
            deployFrequencyCalculator.setConfiguration({
                deployFrequencyData,
                analysisPeriod: doraMetricsConfig.analysisPeriod,
            });

            const deployFrequency =
                deployFrequencyCalculator.calculateDeployFrequency();

            const leadTimeForChangeCalculator =
                new LeadTimeForChangeCalculator();
            leadTimeForChangeCalculator.setConfiguration(
                commitLeadTimeForChangeData,
                doraMetricsConfig.analysisPeriod,
            );

            const leadTimeForChange =
                await leadTimeForChangeCalculator.calculateLeadTimeForChanges();

            return {
                deployFrequency,
                leadTimeForChange,
            };
        } catch (error) {
            throw error;
        }
    }

    private createDoraMetricsToSave(
        metricsResult: DoraMetricsResults,
        teamId: string,
    ): IMetrics[] {
        const deployFrequency: IMetrics = this.createMetric(
            teamId,
            metricsResult.deployFrequency,
            METRICS_TYPE.DEPLOY_FREQUENCY,
        );

        const leadTimeForChange: IMetrics = this.createMetric(
            teamId,
            metricsResult.leadTimeForChange,
            METRICS_TYPE.LEAD_TIME_FOR_CHANGE,
        );

        return [deployFrequency, leadTimeForChange];
    }

    private createMetric(teamId, value, type) {
        return {
            uuid: uuidv4(),
            value: value,
            type: type,
            category: METRICS_CATEGORY.DORA_METRICS,
            team: { uuid: teamId },
            status: true,
        };
    }

    @ValidateCodeManagementIntegration()
    public async getDoraMetricsHistoryWithConfigurableParams(
        organizationAndTeamData: OrganizationAndTeamData,
        metricsConversionStructure?: MetricsConversionStructure,
        metricsConfig?: Partial<TeamMetricsConfig>,
    ): Promise<any> {
        const defaultMetricsConfig: TeamMetricsConfig = {
            howManyMetricsInThePast:
                metricsConfig?.howManyMetricsInThePast ?? 1,
            daysInterval: metricsConfig?.daysInterval ?? 7,
            weekDay: metricsConfig?.weekDay ?? 0,
        };

        const mergedConfig = mergeConfig(defaultMetricsConfig, metricsConfig);

        const metricsResult =
            await this.metricsService.findTeamMetricsHistoryWithConfigurableParams(
                organizationAndTeamData.teamId,
                mergedConfig,
                METRICS_CATEGORY.DORA_METRICS,
            );

        if (!metricsResult?.length) {
            return null;
        }

        switch (metricsConversionStructure) {
            case MetricsConversionStructure.METRICS_TREND:
                return this.metricsService.MapToMetricsTrend(metricsResult);
            case MetricsConversionStructure.I_METRICS:
                return this.metricsService.MapToIMetrics(
                    metricsResult,
                    organizationAndTeamData?.teamId,
                );
            default:
                return metricsResult;
        }
    }

    //#region Metrics History
    @ValidateCodeManagementIntegration()
    async saveAllMetricsHistory(
        organizationAndTeamData: OrganizationAndTeamData,
        startDate: Date,
        endDate: Date,
        doraMetricsConfig?: Partial<DoraMetricsConfig>,
    ) {
        try {
            const historicalStartDate = new Date(startDate);
            historicalStartDate.setDate(historicalStartDate.getDate() - 7);

            const deployFrequencyData = [];

            const commitLeadTimeForChangeData =
                await this.getCommitLeadTimeForChangeData(
                    organizationAndTeamData,
                    startDate,
                    endDate,
                    doraMetricsConfig,
                    deployFrequencyData,
                );

            await this.processAndSaveDeployFrequency(
                deployFrequencyData,
                startDate,
                endDate,
                organizationAndTeamData,
            );

            await this.processAndSaveLeadTimeForChange(
                commitLeadTimeForChangeData,
                startDate,
                endDate,
                organizationAndTeamData,
            );
        } catch (error) {
            this.logError(
                'General error while saving DORA metrics history',
                error,
                organizationAndTeamData,
            );
            throw error;
        }
    }

    private initializeConfig() {
        const { today, dateAfterDaysInformed } = getDayForFilter(90);

        this.analysisPeriodDefault = {
            startTime: new Date(dateAfterDaysInformed),
            endTime: new Date(today),
        };
    }

    private async getCommitLeadTimeForChangeData(
        organizationAndTeamData: OrganizationAndTeamData,
        startDate: Date,
        endDate: Date,
        doraMetricsConfig?: Partial<DoraMetricsConfig>,
        deployFrequencyData?: any,
    ) {
        try {
            return await this.codeManagementService.getCommitsByReleaseMode({
                organizationAndTeamData,
                doraMetricsConfig: {
                    ...doraMetricsConfig,
                    analysisPeriod: { startTime: startDate, endTime: endDate },
                },
                deployFrequencyData,
            });
        } catch (error) {
            this.logError(
                'Error while fetching Lead Time for Change data',
                error,
                organizationAndTeamData,
            );
            return [];
        }
    }

    private async processAndSaveDeployFrequency(
        deployFrequencyData: any,
        startDate: Date,
        endDate: Date,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        try {
            const deployFrequencyHistory = new DeployFrequencyHistory();
            const deployFrequencyMetrics =
                deployFrequencyHistory.prepareDataToBulkCreate({
                    deployFrequencyData,
                    startDate,
                    endDate,
                    teamId: organizationAndTeamData.teamId,
                });

            if (deployFrequencyMetrics) {
                await this.metricsService.bulkCreate(deployFrequencyMetrics);
            }
        } catch (error) {
            this.logError(
                'Error while processing and saving Deploy Frequency metrics',
                error,
                organizationAndTeamData,
            );
        }
    }

    private async processAndSaveLeadTimeForChange(
        commitLeadTimeForChangeData: any,
        startDate: Date,
        endDate: Date,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        try {
            const leadTimeForChangeHistory = new LeadTimeForChangeHistory();
            const leadTimeForChangeMetrics =
                await leadTimeForChangeHistory.prepareDataToBulkCreate({
                    commitLeadTimeForChangeData,
                    startDate,
                    endDate,
                    teamId: organizationAndTeamData.teamId,
                });

            if (leadTimeForChangeMetrics) {
                await this.metricsService.bulkCreate(leadTimeForChangeMetrics);
            }
        } catch (error) {
            this.logError(
                'Error while processing and saving Lead Time for Change metrics',
                error,
                organizationAndTeamData,
            );
            throw error;
        }
    }

    private logError(
        message: string,
        error: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        this.logger.error({
            message,
            context: DoraMetricsFactory.name,
            error,
            metadata: {
                teamId: organizationAndTeamData.teamId,
                organizationId: organizationAndTeamData.organizationId,
            },
        });
    }
    //#endregion
}
