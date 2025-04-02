import { IMetricsRepository } from '@/core/domain/metrics/contracts/metrics.repository.contract';
import { MetricsEntity } from '@/core/domain/metrics/entities/metrics.entity';
import { IMetrics } from '@/core/domain/metrics/interfaces/metrics.interface';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MetricsModel } from './schema/metrics.model';
import { FindManyOptions, FindOneOptions, Repository } from 'typeorm';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import {
    LeadTimeByColumnUnity,
    TeamMetricsConfig,
} from '@/shared/domain/interfaces/metrics';
import { METRICS_CATEGORY } from '@/core/domain/metrics/enums/metricsCategory.enum';
import { v4 as uuidv4 } from 'uuid';
import { getMetricTypesByCategory } from '@/shared/utils/metrics/filterMetricTypesByCategory.utils';

@Injectable()
export class MetricsDatabaseRepository implements IMetricsRepository {
    constructor(
        @InjectRepository(MetricsModel)
        private readonly metricsRepository: Repository<MetricsModel>,
    ) {}

    async find(filter: Partial<IMetrics>): Promise<MetricsEntity[]> {
        try {
            const whereConditions: any = { ...filter };

            const findOneOptions: FindManyOptions<MetricsModel> = {
                where: {
                    ...whereConditions,
                },
                relations: ['team'],
            };

            const metricsModel =
                await this.metricsRepository.find(findOneOptions);

            return mapSimpleModelsToEntities(metricsModel, MetricsEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<MetricsEntity> {
        try {
            if (!uuid) return undefined;

            const findOneOptions: FindOneOptions<MetricsModel> = {
                where: {
                    uuid,
                },
                relations: ['team'],
            };

            const metricsSelected =
                await this.metricsRepository.findOne(findOneOptions);

            if (!metricsSelected) return undefined;

            return mapSimpleModelToEntity(metricsSelected, MetricsEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async findOne(
        findOptions: FindOneOptions<MetricsModel>,
    ): Promise<MetricsEntity> {
        const metricsSelected =
            await this.metricsRepository.findOne(findOptions);

        if (!metricsSelected) return undefined;

        return mapSimpleModelToEntity(metricsSelected, MetricsEntity);
    }

    async create(metricsEntity: IMetrics): Promise<MetricsEntity> {
        try {
            const queryBuilder =
                this.metricsRepository.createQueryBuilder('metrics');

            const automationExecutionModel =
                this.metricsRepository.create(metricsEntity);

            const automationExecutionCreated = await queryBuilder
                .insert()
                .values(automationExecutionModel)
                .execute();

            if (automationExecutionCreated?.identifiers[0]?.uuid) {
                const findOneOptions: FindOneOptions<MetricsModel> = {
                    where: {
                        uuid: automationExecutionCreated.identifiers[0].uuid,
                    },
                };

                const selectedAutomationExecution =
                    await this.metricsRepository.findOne(findOneOptions);

                if (!selectedAutomationExecution) return undefined;

                return mapSimpleModelToEntity(
                    selectedAutomationExecution,
                    MetricsEntity,
                );
            }

            return undefined;
        } catch (error) {
            console.log(error);
        }
    }

    async bulkCreate(metrics: IMetrics[]): Promise<MetricsEntity[]> {
        try {
            const metricsData = await this.metricsRepository.save(metrics);
            return mapSimpleModelToEntity(metricsData, MetricsEntity);
        } catch (error) {
            console.error('Error creating batch metrics:', error);
            throw error;
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.metricsRepository.delete(uuid);
        } catch (error) {
            console.log(error);
        }
    }

    async getSecondToLastSavedMetricsByTeamIdAndMetricType(
        teamId: any,
        type: METRICS_TYPE,
    ): Promise<MetricsEntity> {
        try {
            const lastMetrics = await this.metricsRepository
                .createQueryBuilder('metric')
                .where('metric.team.uuid = :teamId', { teamId })
                .andWhere('metric.type = :type', { type })
                .orderBy('metric.referenceDate', 'DESC')
                .limit(2)
                .getMany();

            const metrics = mapSimpleModelsToEntities(
                lastMetrics,
                MetricsEntity,
            );

            const metricsResult = metrics?.length
                ? (metrics[1] as MetricsEntity)
                : undefined;

            return metricsResult;
        } catch (error) {
            console.log(error);
        }
    }

    async findTeamMetricsHistoryWithConfigurableParams(
        teamId: string,
        metricsConfig?: Partial<TeamMetricsConfig>,
        metricsCategory?: METRICS_CATEGORY,
    ): Promise<MetricsEntity[]> {
        try {
            const config = this.getDefaultConfig(metricsConfig);

            let metricTypes = Object.values(METRICS_TYPE);

            if (metricsCategory) {
                metricTypes = [...getMetricTypesByCategory(metricsCategory)];
            }

            let categoryFilter = metricsCategory
                ? { category: metricsCategory }
                : {};

            const metrics: MetricsEntity[] = [];

            for (const type of metricTypes) {
                const latestMetric = await this.getAndProcessLatestMetric(
                    teamId,
                    type,
                    categoryFilter,
                    config,
                );
                if (latestMetric) {
                    metrics.push(latestMetric);
                }

                // Get historical metrics
                const historicalMetrics = await this.getHistoricalMetrics(
                    teamId,
                    type,
                    categoryFilter,
                    config,
                    latestMetric
                        ? new Date(latestMetric.referenceDate)
                        : new Date(),
                );
                metrics.push(...historicalMetrics);
            }

            const metricsFormatted = metrics.map((metric) => {
                if (
                    metric.type === METRICS_TYPE.LEAD_TIME_BY_COLUMN &&
                    config.leadTimeByColumnUnity
                ) {
                    try {
                        const convertedMetric = this.convertLeadTimeByColumn(
                            [metric],
                            METRICS_TYPE.LEAD_TIME_BY_COLUMN,
                            config.leadTimeByColumnUnity,
                        )[0];

                        const flowEfficiencyMetric =
                            this.convertLeadTimeByColumn(
                                [metric],
                                METRICS_TYPE.FLOW_EFFICIENCY,
                                LeadTimeByColumnUnity.DAYS_AND_PERCENTAGE,
                                true,
                            )[0];

                        return [convertedMetric, flowEfficiencyMetric];
                    } catch (error) {
                        console.error('Error converting metrics:', error);
                        return [metric];
                    }
                }
                return [metric];
            });

            const allMetrics = metricsFormatted.flat();

            const metricsResult = allMetrics.sort(
                (a, b) =>
                    new Date(a.referenceDate).getTime() -
                    new Date(b.referenceDate).getTime(),
            );

            return metricsResult;
        } catch (error) {
            console.error(
                'Error fetching configurable team metrics history:',
                error,
            );
            throw error;
        }
    }

    private calculateHistoricalDates(
        latestDate: Date,
        config: Required<TeamMetricsConfig>,
    ): Date[] {
        const dates: Date[] = [];
        let currentDate = new Date(latestDate);

        while (currentDate.getDay() !== config.weekDay) {
            currentDate.setDate(currentDate.getDate() - 1);
        }

        const startTime = new Date(config.analysisPeriod.startTime);
        startTime.setHours(0, 0, 0, 0);

        while (currentDate >= startTime) {
            dates.push(new Date(currentDate));
            currentDate.setDate(currentDate.getDate() - config.daysInterval);
        }

        const isSameDate = (date1: Date, date2: Date) =>
            date1.getFullYear() === date2.getFullYear() &&
            date1.getMonth() === date2.getMonth() &&
            date1.getDate() === date2.getDate();

        return dates.filter((date) => !isSameDate(date, latestDate));
    }

    private async getHistoricalMetrics(
        teamId: string,
        type: METRICS_TYPE,
        categoryFilter: any,
        config: Required<TeamMetricsConfig>,
        latestDate: Date,
    ): Promise<MetricsEntity[]> {
        const historicalDates = this.calculateHistoricalDates(
            latestDate,
            config,
        );

        if (historicalDates.length === 0) {
            return [];
        }

        if (
            [METRICS_TYPE.THROUGHPUT].includes(type) ||
            [METRICS_TYPE.DELIVERY_CAPACITY].includes(type)
        ) {
            return this.getConsolidatedHistoricalMetrics(
                teamId,
                type,
                historicalDates,
                config.daysInterval,
                categoryFilter,
            );
        } else {
            return this.getNonConsolidatedHistoricalMetrics(
                teamId,
                type,
                historicalDates,
                categoryFilter,
            );
        }
    }

    private async getConsolidatedHistoricalMetrics(
        teamId: string,
        type: METRICS_TYPE,
        historicalDates: Date[],
        daysInterval: number,
        categoryFilter: any,
    ) {
        if ([METRICS_TYPE.THROUGHPUT].includes(type)) {
            return this.getConsolidatedThroughputMetrics(
                teamId,
                historicalDates,
                daysInterval,
                categoryFilter,
            );
        } else if ([METRICS_TYPE.DELIVERY_CAPACITY].includes(type)) {
            return this.getConsolidatedDeliveryCapacityMetrics(
                teamId,
                historicalDates,
                daysInterval,
                categoryFilter,
            );
        }
    }

    private async getConsolidatedThroughputMetrics(
        teamId: string,
        historicalDates: Date[],
        daysInterval: number,
        categoryFilter: any,
    ): Promise<MetricsEntity[]> {
        const consolidatedMetrics: MetricsEntity[] = [];
        for (const endDate of historicalDates) {
            const startDate = new Date(
                endDate.getTime() - daysInterval * 24 * 60 * 60 * 1000,
            );
            startDate.setHours(0, 0, 0, 0);
            endDate.setHours(23, 59, 59, 999);

            const metrics = await this.metricsRepository
                .createQueryBuilder('metric')
                .where('metric.team = :teamId', { teamId })
                .andWhere('metric.type = :type', {
                    type: METRICS_TYPE.THROUGHPUT,
                })
                .andWhere('metric.referenceDate > :startDate', {
                    startDate: startDate.toISOString(),
                })
                .andWhere('metric.referenceDate <= :endDate', {
                    endDate: endDate.toISOString(),
                })
                .andWhere(categoryFilter)
                .orderBy('metric.referenceDate', 'DESC')
                .getMany();

            const consolidatedValue = {
                value: metrics.reduce(
                    (sum, metric) => sum + metric.value.value,
                    0,
                ),
            };

            const throughputByItemType = metrics
                .filter(
                    (metric) =>
                        metric.value &&
                        Array.isArray(metric.value.throughputByItemType),
                )
                .map((metric) => metric.value.throughputByItemType)
                .flat();

            consolidatedMetrics.push(
                MetricsEntity.create({
                    uuid: uuidv4(),
                    type: METRICS_TYPE.THROUGHPUT,
                    value: {
                        total: consolidatedValue,
                        completeResult: throughputByItemType,
                    },
                    referenceDate: endDate.toISOString(),
                    team: { uuid: teamId },
                    status: true,
                    category:
                        categoryFilter.category ||
                        METRICS_CATEGORY.FLOW_METRICS,
                }),
            );
        }

        return consolidatedMetrics;
    }

    private async getConsolidatedDeliveryCapacityMetrics(
        teamId: string,
        historicalDates: Date[],
        daysInterval: number,
        categoryFilter: any,
    ): Promise<MetricsEntity[]> {
        const consolidatedMetrics: MetricsEntity[] = [];

        for (const endDate of historicalDates) {
            const startDate = new Date(
                endDate.getTime() - daysInterval * 24 * 60 * 60 * 1000,
            );
            startDate.setHours(0, 0, 0, 0);
            endDate.setHours(23, 59, 59, 999);

            const metrics = await this.metricsRepository
                .createQueryBuilder('metric')
                .where('metric.team = :teamId', { teamId })
                .andWhere('metric.type = :type', {
                    type: METRICS_TYPE.DELIVERY_CAPACITY,
                })
                .andWhere('metric.referenceDate > :startDate', {
                    startDate: startDate.toISOString(),
                })
                .andWhere('metric.referenceDate <= :endDate', {
                    endDate: endDate.toISOString(),
                })
                .andWhere(categoryFilter)
                .orderBy('metric.referenceDate', 'DESC')
                .getMany();

            const consolidatedValue = {
                deliveryCapacityFromTodo: {
                    deliveredItems: 0,
                    newTodoItems: 0,
                },
                deliveryCapacityFromCreation: {
                    deliveredItems: 0,
                    newItems: 0,
                },
            };

            metrics.forEach((metric) => {
                consolidatedValue.deliveryCapacityFromTodo.deliveredItems +=
                    metric.value.deliveryCapacityFromTodo.deliveredItems;
                consolidatedValue.deliveryCapacityFromTodo.newTodoItems +=
                    metric.value.deliveryCapacityFromTodo.newTodoItems;
                consolidatedValue.deliveryCapacityFromCreation.deliveredItems +=
                    metric.value.deliveryCapacityFromCreation.deliveredItems;
                consolidatedValue.deliveryCapacityFromCreation.newItems +=
                    metric.value.deliveryCapacityFromCreation.newItems;
            });

            consolidatedMetrics.push(
                MetricsEntity.create({
                    uuid: uuidv4(),
                    type: METRICS_TYPE.DELIVERY_CAPACITY,
                    value: consolidatedValue,
                    referenceDate: endDate.toISOString(),
                    team: { uuid: teamId },
                    status: true,
                    category:
                        categoryFilter.category ||
                        METRICS_CATEGORY.FLOW_METRICS,
                }),
            );
        }

        return consolidatedMetrics;
    }

    private async getNonConsolidatedHistoricalMetrics(
        teamId: string,
        type: METRICS_TYPE,
        historicalDates: Date[],
        categoryFilter: any,
    ): Promise<MetricsEntity[]> {
        const metrics = await this.metricsRepository
            .createQueryBuilder('metric')
            .where('metric.team = :teamId', { teamId })
            .andWhere('metric.type = :type', { type })
            .andWhere('DATE(metric.referenceDate) IN (:...dates)', {
                dates: historicalDates.map((d) => d.toISOString()),
            })
            .andWhere(categoryFilter)
            .orderBy('metric.referenceDate', 'DESC')
            .getMany();

        return metrics.map((metric) =>
            MetricsEntity.create(this.mapMetricsModelToIMetrics(metric)),
        );
    }

    private async getAndProcessLatestMetric(
        teamId: string,
        type: METRICS_TYPE,
        categoryFilter: any,
        config: Required<TeamMetricsConfig>,
    ): Promise<MetricsEntity | null> {
        const latestMetric = await this.getLatestMetric(
            teamId,
            type,
            categoryFilter,
            config,
        );
        if (!latestMetric) return null;

        return latestMetric;
    }

    private getDefaultConfig(
        metricsConfig?: Partial<TeamMetricsConfig>,
    ): Required<TeamMetricsConfig> {
        return {
            weekDay: metricsConfig?.weekDay ?? 0,
            daysInterval: metricsConfig?.daysInterval ?? 7,
            howManyMetricsInThePast:
                metricsConfig?.howManyMetricsInThePast ?? 1,
            analysisPeriod: metricsConfig?.analysisPeriod ?? {
                startTime: new Date(
                    new Date().setMonth(new Date().getMonth() - 90),
                ),
                endTime: new Date(),
            },
            considerAll: metricsConfig?.considerAll ?? false,
            howManyHistoricalDays: metricsConfig?.howManyHistoricalDays ?? 90,
            leadTimeByColumnUnity:
                metricsConfig?.leadTimeByColumnUnity ??
                LeadTimeByColumnUnity.HOURS,
        };
    }

    private async getLatestMetric(
        teamId: string,
        type: METRICS_TYPE,
        categoryFilter: any,
        metricsConfig: TeamMetricsConfig,
    ): Promise<MetricsEntity | null> {
        if (type === METRICS_TYPE.THROUGHPUT) {
            return this.getLatestThroughputMetric(
                teamId,
                categoryFilter,
                metricsConfig,
            );
        }

        return this.getLatestRegularMetric(
            teamId,
            type,
            categoryFilter,
            metricsConfig,
        );
    }

    private async getLatestRegularMetric(
        teamId: string,
        type: METRICS_TYPE,
        categoryFilter: any,
        metricsConfig: TeamMetricsConfig,
    ): Promise<MetricsEntity | null> {
        const queryBuilder = this.metricsRepository
            .createQueryBuilder('metric')
            .where('metric.team = :teamId', { teamId })
            .andWhere('metric.type = :type', { type })
            .andWhere(categoryFilter);

        if (metricsConfig.analysisPeriod?.endTime) {
            const endDate = new Date(metricsConfig.analysisPeriod.endTime);
            endDate.setHours(23, 59, 59, 999);

            queryBuilder.andWhere(
                'DATE(metric.referenceDate) <= DATE(:endDate)',
                {
                    endDate: endDate.toISOString().split('T')[0],
                },
            );
        }

        const latestMetric = await queryBuilder
            .orderBy('metric.referenceDate', 'DESC')
            .getOne();

        return latestMetric
            ? MetricsEntity.create(this.mapMetricsModelToIMetrics(latestMetric))
            : null;
    }

    private async getLatestThroughputMetric(
        teamId: string,
        categoryFilter: any,
        metricsConfig: TeamMetricsConfig,
    ): Promise<MetricsEntity | null> {
        const endDate = metricsConfig.analysisPeriod?.endTime
            ? new Date(metricsConfig.analysisPeriod.endTime)
            : new Date();
        endDate.setHours(23, 59, 59, 999);

        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - 6);
        startDate.setHours(0, 0, 0, 0);

        const metrics = await this.metricsRepository
            .createQueryBuilder('metric')
            .where('metric.team = :teamId', { teamId })
            .andWhere('metric.type = :type', { type: METRICS_TYPE.THROUGHPUT })
            .andWhere('metric.referenceDate >= :startDate', {
                startDate: startDate.toISOString(),
            })
            .andWhere('metric.referenceDate <= :endDate', {
                endDate: endDate.toISOString(),
            })
            .andWhere(categoryFilter)
            .orderBy('metric.referenceDate', 'DESC')
            .getMany();

        if (!metrics.length) return null;

        const totalValue = metrics.reduce(
            (sum, metric) => sum + metric.value.value,
            0,
        );
        const throughputByItemType = metrics
            .flatMap((metric) => metric.value.throughputByItemType || [])
            .reduce((acc, item) => {
                const existing = acc.find(
                    (x) => x.workItemTypeId === item.workItemTypeId,
                );
                if (existing) {
                    existing.value += item.value;
                } else {
                    acc.push({ ...item });
                }
                return acc;
            }, []);

        // Recalculate the percentages
        const total = throughputByItemType.reduce(
            (sum, item) => sum + item.value,
            0,
        );
        throughputByItemType.forEach((item) => {
            item.percentageOfTotal = (item.value / total) * 100;
        });

        return MetricsEntity.create({
            uuid: metrics[0].uuid,
            type: METRICS_TYPE.THROUGHPUT,
            value: {
                value: totalValue,
                throughputByItemType,
            },
            status: true,
            team: { uuid: teamId },
            category: metrics[0].category,
            referenceDate: metrics[0].referenceDate.toISOString(),
            createdAt: metrics[0].createdAt.toISOString(),
        });
    }

    private mapMetricsModelToIMetrics(model: MetricsModel): IMetrics {
        return {
            uuid: model.uuid,
            type: model.type as METRICS_TYPE,
            value: model.value,
            status: model.status,
            team: model.team,
            createdAt: model.referenceDate?.toISOString(),
            category: model.category as METRICS_CATEGORY,
            referenceDate: model.referenceDate?.toISOString(),
        };
    }

    private convertLeadTimeByColumn(
        metrics: MetricsEntity[],
        metricType: METRICS_TYPE,
        unity: LeadTimeByColumnUnity,
        generateUuid: boolean = false,
    ): MetricsEntity[] {
        return metrics.map((metric) => {
            if (
                metric.type === METRICS_TYPE.LEAD_TIME_BY_COLUMN &&
                metric.value &&
                metric.value.columns
            ) {
                const columns = metric.value.columns;
                let convertedValue: { [key: string]: any } = {};

                columns.forEach((column) => {
                    switch (unity) {
                        case LeadTimeByColumnUnity.HOURS:
                            convertedValue[column.name] = column.hours;
                            break;
                        case LeadTimeByColumnUnity.DAYS:
                            convertedValue[column.name] = column.days;
                            break;
                        case LeadTimeByColumnUnity.DAYS_AND_PERCENTAGE:
                            convertedValue[column.name] = {
                                days: column.days,
                                percentage: column.percentageOfTotal,
                            };
                            break;
                        case LeadTimeByColumnUnity.PERCENTAGE:
                            convertedValue[column.name] =
                                column.percentageOfTotal;
                            break;
                        default:
                            convertedValue[column.name] = column.hours;
                    }
                });

                return new MetricsEntity({
                    uuid: generateUuid ? uuidv4() : metric.uuid,
                    type: metricType,
                    value: convertedValue,
                    status: metric.status,
                    team: metric.team,
                    createdAt: metric.createdAt,
                    category: metric.category,
                    referenceDate: metric.referenceDate,
                });
            }
            return metric;
        });
    }
}
