import { IMetrics } from '@/core/domain/metrics/interfaces/metrics.interface';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindManyOptions, FindOneOptions, Repository } from 'typeorm';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { IOrganizationMetricsRepository } from '@/core/domain/organizationMetrics/contracts/organizationMetrics.repository.contract';
import { IOrganizationMetrics } from '@/core/domain/organizationMetrics/interfaces/organizationMetrics.interface';
import { OrganizationMetricsModel } from './schema/organizationMetrics.model';
import { OrganizationMetricsEntity } from '@/core/domain/organizationMetrics/entities/organizationMetrics.entity';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class OrganizationMetricsDatabaseRepository
    implements IOrganizationMetricsRepository
{
    constructor(
        @InjectRepository(OrganizationMetricsModel)
        private readonly organizationMetricsRepository: Repository<OrganizationMetricsModel>,
    ) {}

    async find(
        filter: Partial<IOrganizationMetrics>,
    ): Promise<OrganizationMetricsEntity[]> {
        try {
            const whereConditions: any = { ...filter };

            const findOneOptions: FindManyOptions<OrganizationMetricsModel> = {
                where: {
                    ...whereConditions,
                },
                relations: ['organization'],
            };

            const metricsModel =
                await this.organizationMetricsRepository.find(findOneOptions);

            return mapSimpleModelsToEntities(
                metricsModel,
                OrganizationMetricsEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<OrganizationMetricsEntity> {
        try {
            if (!uuid) return undefined;

            const findOneOptions: FindOneOptions<OrganizationMetricsModel> = {
                where: {
                    uuid,
                },
                relations: ['organization'],
            };

            const metricsSelected =
                await this.organizationMetricsRepository.findOne(
                    findOneOptions,
                );

            if (!metricsSelected) return undefined;

            return mapSimpleModelToEntity(
                metricsSelected,
                OrganizationMetricsEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async findOne(
        findOptions: FindOneOptions<OrganizationMetricsModel>,
    ): Promise<OrganizationMetricsEntity> {
        const metricsSelected =
            await this.organizationMetricsRepository.findOne(findOptions);

        if (!metricsSelected) return undefined;

        return mapSimpleModelToEntity(
            metricsSelected,
            OrganizationMetricsEntity,
        );
    }

    async create(metricsEntity: IMetrics): Promise<OrganizationMetricsEntity> {
        try {
            const queryBuilder =
                this.organizationMetricsRepository.createQueryBuilder(
                    'metrics',
                );

            const automationExecutionModel =
                this.organizationMetricsRepository.create(metricsEntity);

            const automationExecutionCreated = await queryBuilder
                .insert()
                .values(automationExecutionModel)
                .execute();

            if (automationExecutionCreated?.identifiers[0]?.uuid) {
                const findOneOptions: FindOneOptions<OrganizationMetricsModel> =
                    {
                        where: {
                            uuid: automationExecutionCreated.identifiers[0]
                                .uuid,
                        },
                    };

                const selectedAutomationExecution =
                    await this.organizationMetricsRepository.findOne(
                        findOneOptions,
                    );

                if (!selectedAutomationExecution) return undefined;

                return mapSimpleModelToEntity(
                    selectedAutomationExecution,
                    OrganizationMetricsEntity,
                );
            }

            return undefined;
        } catch (error) {
            console.log(error);
        }
    }

    async bulkCreate(
        metrics: IMetrics[],
    ): Promise<OrganizationMetricsEntity[]> {
        try {
            const metricsData =
                await this.organizationMetricsRepository.save(metrics);
            return mapSimpleModelToEntity(
                metricsData,
                OrganizationMetricsEntity,
            );
        } catch (error) {
            console.error('Error creating batch metrics:', error);
            throw error;
        }
    }

    async delete(
        organizationId: string,
        metricsCategory?: METRICS_CATEGORY,
    ): Promise<void> {
        try {
            await this.organizationMetricsRepository.delete({
                organization: { uuid: organizationId },
                category: metricsCategory,
            });
        } catch (error) {
            console.log(error);
        }
    }

    async getSecondToLastSavedMetricsByTeamIdAndMetricType(
        organizationId: any,
        type: METRICS_TYPE,
    ): Promise<OrganizationMetricsEntity> {
        try {
            const lastMetrics = await this.organizationMetricsRepository
                .createQueryBuilder('metric')
                .where('metric.organization.uuid = :organizationId', {
                    organizationId,
                })
                .andWhere('metric.type = :type', { type })
                .orderBy('metric.referenceDate', 'DESC')
                .limit(2)
                .getMany();

            const metrics = mapSimpleModelsToEntities(
                lastMetrics,
                OrganizationMetricsEntity,
            );

            return metrics?.length
                ? (metrics[1] as OrganizationMetricsEntity)
                : undefined;
        } catch (error) {
            console.log(error);
        }
    }

    async findLastSavedMetricsByOrganizationIdAndWeeks(
        organizationId: string,
        howManyWeeks: number,
        metricsCategory?: METRICS_CATEGORY,
    ): Promise<OrganizationMetricsEntity[]> {
        try {
            const lastReferenceDate = await this.getLastReferenceDate(
                organizationId,
                metricsCategory,
            );

            if (!lastReferenceDate) {
                return [];
            }

            const relevantDates = this.getRelevantDates(
                lastReferenceDate,
                howManyWeeks,
            );

            const queryBuilder = this.organizationMetricsRepository
                .createQueryBuilder('metric')
                .where('metric.organization.uuid = :organizationId', {
                    organizationId,
                })
                .andWhere((qb) => {
                    const subQuery = qb
                        .subQuery()
                        .select('MAX(m.referenceDate)')
                        .from(OrganizationMetricsModel, 'm')
                        .where('m.organization.uuid = :organizationId', {
                            organizationId,
                        })
                        .getQuery();
                    return (
                        'CAST(metric.referenceDate AS DATE) = CAST(' +
                        subQuery +
                        ' AS DATE)'
                    );
                })
                .orWhere('DATE(metric.referenceDate) IN (:...relevantDates)', {
                    relevantDates,
                })
                .orderBy('metric.referenceDate', 'DESC')
                .addOrderBy('metric.type', 'ASC');

            const metrics = await queryBuilder.getMany();

            const throughputMetrics = await this.fetchPreviousWeekThroughput(
                organizationId,
                lastReferenceDate,
                howManyWeeks,
            );

            const consolidatedThroughput = this.consolidateThroughputMetrics(
                throughputMetrics,
                [
                    ...relevantDates,
                    lastReferenceDate.toISOString().split('T')[0],
                ],
            );

            let allMetrics = metrics.filter(
                (metric) =>
                    metric.type !== METRICS_TYPE.THROUGHPUT &&
                    metric.type !== METRICS_TYPE.LEAD_TIME,
            );
            allMetrics = [...allMetrics, ...consolidatedThroughput];

            let filteredMetrics = allMetrics;

            if (metricsCategory) {
                filteredMetrics = filteredMetrics.filter(
                    (metric) => metric.category === metricsCategory,
                );
            }

            return this.mapModelsToEntities(filteredMetrics);
        } catch (error) {
            console.error('Error fetching organization metrics:', error);
            throw new Error('Failed to fetch organization metrics');
        }
    }

    private async getLastReferenceDate(
        organizationId: string,
        metricsCategory?: METRICS_CATEGORY,
    ): Promise<Date | null> {
        const queryBuilder = this.organizationMetricsRepository
            .createQueryBuilder('metric')
            .where('metric.organization.uuid = :organizationId', {
                organizationId,
            })
            .orderBy('metric.referenceDate', 'DESC')
            .select('metric.referenceDate', 'lastDate');

        if (metricsCategory) {
            queryBuilder.andWhere('metric.category = :metricsCategory', {
                metricsCategory,
            });
        }

        const result = await queryBuilder.getRawOne();
        return result ? result.lastDate : null;
    }

    private getRelevantDates(
        lastReferenceDate: Date,
        howManyWeeks: number,
    ): string[] {
        const dates = [];
        let currentDate = this.getPreviousSunday(lastReferenceDate);

        for (let i = 0; i < howManyWeeks; i++) {
            dates.push(currentDate.toISOString().split('T')[0]);
            currentDate.setDate(currentDate.getDate() - 7);
        }

        if (dates.length === 1) {
            const lastReferenceDateString = lastReferenceDate
                .toISOString()
                .split('T')[0];
            if (dates[0] === lastReferenceDateString) {
                const newDate = new Date(lastReferenceDate);
                newDate.setDate(newDate.getDate() - 7);
                return [newDate.toISOString().split('T')[0]];
            }
        }

        return dates;
    }

    private getPreviousSunday(date: Date): Date {
        const result = new Date(date);
        result.setDate(result.getDate() - result.getDay());
        return result;
    }

    private async fetchPreviousWeekThroughput(
        organizationId: string,
        lastReferenceDate: Date,
        howManyWeeks: number,
    ): Promise<OrganizationMetricsModel[]> {
        const oldestDate = new Date(lastReferenceDate);
        oldestDate.setDate(oldestDate.getDate() - (7 * howManyWeeks + 6)); // One extra week to ensure

        const throughputMetrics = await this.organizationMetricsRepository
            .createQueryBuilder('metric')
            .where('metric.organization.uuid = :organizationId', {
                organizationId,
            })
            .andWhere('metric.type = :type', { type: 'throughput' })
            .andWhere('CAST(metric.referenceDate AS DATE) <= :lastDate', {
                lastDate: lastReferenceDate.toISOString().split('T')[0],
            })
            .andWhere('CAST(metric.referenceDate AS DATE) >= :oldestDate', {
                oldestDate: oldestDate.toISOString().split('T')[0],
            })
            .orderBy('metric.referenceDate', 'DESC')
            .getMany();

        return throughputMetrics;
    }

    private consolidateThroughputMetrics(
        throughputMetrics: OrganizationMetricsModel[],
        relevantDates: string[],
    ): OrganizationMetricsModel[] {
        const consolidatedMetrics: OrganizationMetricsModel[] = [];

        for (const date of relevantDates) {
            const endDate = new Date(date);
            const startDate = new Date(endDate);
            startDate.setDate(startDate.getDate() - 6);

            const weekMetrics = throughputMetrics.filter((metric) => {
                const metricDate = new Date(metric.referenceDate);
                return metricDate > startDate && metricDate <= endDate;
            });

            const totalValue = weekMetrics.reduce(
                (sum, metric) => sum + metric.value,
                0,
            );

            if (weekMetrics.length > 0 || totalValue > 0) {
                const consolidatedMetric = new OrganizationMetricsModel();
                Object.assign(
                    consolidatedMetric,
                    weekMetrics[0] || throughputMetrics[0],
                );
                consolidatedMetric.value = totalValue;
                consolidatedMetric.referenceDate = endDate;
                consolidatedMetric.uuid = uuidv4(); // Generate new UUID for the consolidated metric
                consolidatedMetrics.push(consolidatedMetric);
            }
        }

        return consolidatedMetrics;
    }

    private mapModelsToEntities(
        models: OrganizationMetricsModel[],
    ): OrganizationMetricsEntity[] {
        return models.map((model) => {
            const metrics: IOrganizationMetrics = {
                uuid: model.uuid,
                type: model.type,
                value: model.value,
                status: model.status,
                organization: model.organization
                    ? { uuid: model.organization.uuid }
                    : undefined,
                createdAt: model.createdAt.toISOString(),
                referenceDate: model.referenceDate.toISOString(),
                category: model.category || undefined,
            };
            return new OrganizationMetricsEntity(metrics);
        });
    }
}
