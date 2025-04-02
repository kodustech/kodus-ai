import { IOrganizationMetricsRepository } from './organizationMetrics.repository.contract';
import { METRICS_CATEGORY } from '../../metrics/enums/metricsCategory.enum';
import { STATUS } from '@/config/types/database/status.type';

export const ORGANIZATION_METRICS_SERVICE_TOKEN = Symbol(
    'OrganizationMetricsService',
);

export interface IOrganizationMetricsService
    extends IOrganizationMetricsRepository {
    calculateRealTimeFlowMetricsForCompany(
        organizationId: string,
    ): Promise<any>;
    calculateRealTimeDoraMetricsForCompany(
        organizationId: string,
    ): Promise<any>;
    runDaily(
        organizationId: string,
        metricsCategory?: METRICS_CATEGORY,
    ): Promise<any>;
    saveAllMetricsHistory(params: {
        organizationId: string,
        howManyHistoricalDays: number,
        metricsCategory?: METRICS_CATEGORY;
        teamStatus?: STATUS;
    }): Promise<void>;
    compareCurrentAndLastWeekFlowMetrics(params: {
        organizationId: string;
    }): Promise<any>;
    compareCurrentAndLastWeekDoraMetrics(params: {
        organizationId: string;
    }): Promise<any>;
}
