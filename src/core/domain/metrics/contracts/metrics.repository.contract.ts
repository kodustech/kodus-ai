import { FindOneOptions } from 'typeorm';
import { MetricsEntity } from '../entities/metrics.entity';
import { IMetrics } from '../interfaces/metrics.interface';
import { MetricsModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/metrics.model';
import { METRICS_TYPE } from '../enums/metrics.enum';
import { TeamMetricsConfig } from '@/shared/domain/interfaces/metrics';
import { METRICS_CATEGORY } from '../enums/metricsCategory.enum';

export const METRICS_REPOSITORY_TOKEN = Symbol('MetricsRepository');

export interface IMetricsRepository {
    find(filter: Partial<IMetrics>): Promise<MetricsEntity[]>;
    findOne(
        findOptions: FindOneOptions<MetricsModel>,
    ): Promise<MetricsEntity | undefined>;
    create(metricsEntity: IMetrics): Promise<MetricsEntity | undefined>;
    bulkCreate(metrics: IMetrics[]): Promise<MetricsEntity[]> | undefined;
    getSecondToLastSavedMetricsByTeamIdAndMetricType(
        teamId: string,
        type: METRICS_TYPE,
    ): Promise<MetricsEntity | undefined>;
    findTeamMetricsHistoryWithConfigurableParams(
        teamId: string,
        metricsConfig?: Partial<TeamMetricsConfig>,
        metricsCategory?: METRICS_CATEGORY,
    ): Promise<MetricsEntity[]>
}
