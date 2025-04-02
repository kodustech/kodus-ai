import { FindOneOptions } from 'typeorm';
import { IOrganizationMetrics } from '../interfaces/organizationMetrics.interface';
import { OrganizationMetricsEntity } from '../entities/organizationMetrics.entity';
import { OrganizationMetricsModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/organizationMetrics.model';
import { METRICS_CATEGORY } from '../../metrics/enums/metricsCategory.enum';

export const ORGANIZATION_METRICS_REPOSITORY_TOKEN = Symbol(
    'OrganizationMetricsRepository',
);

export interface IOrganizationMetricsRepository {
    find(
        filter: Partial<IOrganizationMetrics>,
    ): Promise<OrganizationMetricsEntity[]>;
    findById(uuid: string): Promise<OrganizationMetricsEntity | undefined>;
    findOne(
        findOptions: FindOneOptions<OrganizationMetricsModel>,
    ): Promise<OrganizationMetricsEntity | undefined>;
    findLastSavedMetricsByOrganizationIdAndWeeks(
        organizationId: string,
        howManyWeeks: number,
        metricsCategory?: METRICS_CATEGORY,
    ): Promise<OrganizationMetricsEntity[]>;
    create(
        metricsEntity: IOrganizationMetrics,
    ): Promise<OrganizationMetricsEntity | undefined>;
    bulkCreate(
        metricsEntity: IOrganizationMetrics[],
    ): Promise<OrganizationMetricsEntity[] | undefined>;
    delete(
        organizationId: string,
        metricsCategory?: METRICS_CATEGORY,
    ): Promise<void>;
}
