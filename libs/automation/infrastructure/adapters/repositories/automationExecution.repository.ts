import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    FindManyOptions,
    FindOneOptions,
    FindOptionsWhere,
    Repository,
} from 'typeorm';

import { createLogger } from '@kodus/flow';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { IAutomationExecutionRepository } from '@libs/automation/domain/automationExecution/contracts/automation-execution.repository';
import { AutomationExecutionEntity } from '@libs/automation/domain/automationExecution/entities/automation-execution.entity';
import { IAutomationExecution } from '@libs/automation/domain/automationExecution/interfaces/automation-execution.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@libs/core/infrastructure/repositories/mappers';
import { createNestedConditions } from '@libs/core/infrastructure/repositories/model/filters';

import { AutomationExecutionModel } from './schemas/automationExecution.model';

@Injectable()
export class AutomationExecutionRepository implements IAutomationExecutionRepository {
    private readonly logger = createLogger(AutomationExecutionRepository.name);

    constructor(
        @InjectRepository(AutomationExecutionModel)
        private readonly automationExecutionRepository: Repository<AutomationExecutionModel>,
    ) {}

    async create(
        automationExecution: IAutomationExecution,
    ): Promise<AutomationExecutionEntity> {
        try {
            const queryBuilder =
                this.automationExecutionRepository.createQueryBuilder(
                    'automationExecution',
                );

            const automationExecutionModel =
                this.automationExecutionRepository.create(automationExecution);

            const automationExecutionCreated = await queryBuilder
                .insert()
                .values(automationExecutionModel)
                .execute();

            if (automationExecutionCreated) {
                const findOneOptions: FindOneOptions<AutomationExecutionModel> =
                    {
                        where: {
                            uuid: automationExecutionCreated.identifiers[0]
                                .uuid,
                        },
                    };

                const selectedAutomationExecution =
                    await this.automationExecutionRepository.findOne(
                        findOneOptions,
                    );

                if (!selectedAutomationExecution) return undefined;

                return mapSimpleModelToEntity(
                    selectedAutomationExecution,
                    AutomationExecutionEntity,
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to create automation execution',
                context: AutomationExecutionRepository.name,
                error,
            });
        }
    }

    async update(
        filter: Partial<IAutomationExecution>,
        data: Omit<
            Partial<IAutomationExecution>,
            'uuid' | 'createdAt' | 'updatedAt'
        >,
    ): Promise<AutomationExecutionEntity> {
        try {
            const conditions = this.getFilterConditions(filter);

            const updateResult =
                await this.automationExecutionRepository.update(
                    conditions,
                    data,
                );

            if (updateResult.affected === 0) {
                this.logger.warn({
                    message: 'No automation execution found for update',
                    context: AutomationExecutionRepository.name,
                    metadata: { filter },
                });
                return null;
            }

            // 3. Fetch the updated entity to return it. This ensures you get the fresh data.
            const updatedEntity =
                await this.automationExecutionRepository.findOne({
                    where: conditions,
                });

            return mapSimpleModelToEntity(
                updatedEntity,
                AutomationExecutionEntity,
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to update automation execution',
                context: AutomationExecutionRepository.name,
                error,
                metadata: { filter },
            });
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.automationExecutionRepository.delete(uuid);
        } catch (error) {
            this.logger.error({
                message: 'Failed to delete automation execution',
                context: AutomationExecutionRepository.name,
                error,
                metadata: { uuid },
            });
        }
    }

    async findById(uuid: string): Promise<AutomationExecutionEntity> {
        try {
            const queryBuilder =
                this.automationExecutionRepository.createQueryBuilder(
                    'automationExecution',
                );

            const automationExecutionSelected = await queryBuilder
                .where('automationExecution.uuid = :uuid', { uuid })
                .getOne();

            return mapSimpleModelToEntity(
                automationExecutionSelected,
                AutomationExecutionEntity,
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to find automation execution by id',
                context: AutomationExecutionRepository.name,
                error,
                metadata: { uuid },
            });
        }
    }

    async find(
        filter?: Partial<IAutomationExecution>,
    ): Promise<AutomationExecutionEntity[]> {
        try {
            // Determine which relations to load based on the filter
            const relations = ['teamAutomation', 'codeReviewExecutions'];

            // Only load deep nested relations if the filter requires them
            if (filter?.teamAutomation) {
                const teamAutomationFilter = filter.teamAutomation;
                if (teamAutomationFilter.team) {
                    relations.push('teamAutomation.team');
                    if (teamAutomationFilter.team.organization) {
                        relations.push('teamAutomation.team.organization');
                    }
                }
            }

            const findOneOptions: FindManyOptions<AutomationExecutionModel> = {
                where: filter as FindOptionsWhere<AutomationExecutionModel>,
                relations,
            };

            const automationModel =
                await this.automationExecutionRepository.find(findOneOptions);

            return mapSimpleModelsToEntities(
                automationModel,
                AutomationExecutionEntity,
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to find automation executions',
                context: AutomationExecutionRepository.name,
                error,
                metadata: { filter },
            });
        }
    }

    async findPullRequestExecutionsByOrganizationAndTeam(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryIds?: string[];
        repositoryName?: string;
        pullRequestNumber?: number;
        pullRequestTitle?: string;
        prFilters?: Array<{ number: number; repositoryId: string }>;
        skip?: number;
        take?: number;
        order?: 'ASC' | 'DESC';
        includeTotal?: boolean;
    }): Promise<{ data: AutomationExecutionEntity[]; total: number }> {
        const {
            organizationAndTeamData,
            repositoryIds,
            repositoryName,
            pullRequestNumber,
            pullRequestTitle: _pullRequestTitle,
            prFilters,
            skip = 0,
            take = 30,
            order = 'DESC',
            includeTotal = true,
        } = params;

        try {
            const { organizationId, teamId } = organizationAndTeamData;

            const queryBuilder =
                this.automationExecutionRepository.createQueryBuilder(
                    'automation_execution',
                );

            // EXISTS filter instead of INNER JOIN on codeReviewExecutions.
            // The join was 1:N and forced TypeORM to wrap the query in a
            // DISTINCT ON (uuid, createdAt) for pagination — cartesian product
            // of executions × reviews. Callers only use the filter semantics
            // ("execution has at least one review"); they load reviews
            // separately via codeReviewMap (see GetEnrichedPullRequestsUseCase).
            queryBuilder
                .select([
                    'automation_execution.uuid',
                    'automation_execution.createdAt',
                    'automation_execution.updatedAt',
                    'automation_execution.status',
                    'automation_execution.errorMessage',
                    'automation_execution.origin',
                    'automation_execution.pullRequestNumber',
                    'automation_execution.repositoryId',
                    // TypeORM property-path syntax (not raw SQL) so the
                    // jsonb value hydrates onto the entity's
                    // `dataExecution` field. The previous quoted form
                    // (`"automation_execution"."dataExecution"`) was raw
                    // SQL — TypeORM included the column in the query
                    // result but didn't map it back to the entity, so
                    // `execution.dataExecution` came through as
                    // undefined even though the row had it. The bug
                    // hid until something tried to read a nested field
                    // (review fidelity warnings in the admin
                    // dashboard) and got `null` for every row.
                    'automation_execution.dataExecution',
                    'teamAutomation.uuid',
                    'team.name',
                ])
                .innerJoin(
                    'automation_execution.teamAutomation',
                    'teamAutomation',
                )
                .innerJoin('teamAutomation.team', 'team')
                .innerJoin('team.organization', 'organization')
                .where('automation_execution.pullRequestNumber IS NOT NULL')
                .andWhere('automation_execution.repositoryId IS NOT NULL')
                .andWhere('organization.uuid = :organizationId', {
                    organizationId,
                })
                .andWhere('team.uuid = :teamId', { teamId })
                .andWhere(
                    'EXISTS (SELECT 1 FROM "code_review_execution" "cre" WHERE "cre"."automation_execution_id" = "automation_execution"."uuid")',
                );

            if (repositoryIds?.length) {
                if (repositoryIds.length === 1) {
                    queryBuilder.andWhere(
                        'automation_execution.repositoryId = :repositoryId',
                        { repositoryId: repositoryIds[0] },
                    );
                } else {
                    queryBuilder.andWhere(
                        'automation_execution.repositoryId IN (:...repositoryIds)',
                        { repositoryIds },
                    );
                }
            }

            if (pullRequestNumber !== undefined) {
                queryBuilder.andWhere(
                    'automation_execution.pullRequestNumber = :pullRequestNumber',
                    { pullRequestNumber },
                );
            }

            if (repositoryName) {
                queryBuilder.andWhere(
                    "automation_execution.dataExecution->'repository'->>'name' = :repositoryName",
                    { repositoryName },
                );
            }

            if (prFilters?.length) {
                // Filter by specific PR numbers and repository IDs
                const prConditions = prFilters
                    .map(
                        (pr, index) =>
                            `(automation_execution.pullRequestNumber = :prNumber${index} AND automation_execution.repositoryId = :repoId${index})`,
                    )
                    .join(' OR ');

                const prParams = prFilters.reduce(
                    (acc, pr, index) => {
                        acc[`prNumber${index}`] = pr.number;
                        acc[`repoId${index}`] = pr.repositoryId;
                        return acc;
                    },
                    {} as Record<string, any>,
                );

                queryBuilder.andWhere(`(${prConditions})`, prParams);
            }

            let total = 0;
            if (includeTotal) {
                total = await queryBuilder.getCount();

                if (total === 0) {
                    return { data: [], total: 0 };
                }
            }

            const executions = await queryBuilder
                .orderBy('automation_execution.createdAt', order)
                .skip(skip)
                .take(take)
                .getMany();

            const mapped =
                (mapSimpleModelsToEntities(
                    executions,
                    AutomationExecutionEntity,
                ) as AutomationExecutionEntity[]) ?? [];

            return { data: mapped, total };
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to find pull request executions by organization',
                context: AutomationExecutionRepository.name,
                error,
                metadata: { params },
            });
            return { data: [], total: 0 };
        }
    }

    async findCliReviewExecutionsByOrganization(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId?: string;
        userEmail?: string;
        since?: Date;
        skip?: number;
        take?: number;
        order?: 'ASC' | 'DESC';
        includeTotal?: boolean;
    }): Promise<{ data: AutomationExecutionEntity[]; total: number }> {
        const {
            organizationAndTeamData,
            repositoryId,
            userEmail,
            since,
            skip = 0,
            take = 30,
            order = 'DESC',
            includeTotal = true,
        } = params;

        const { organizationId, teamId } = organizationAndTeamData ?? {};

        if (!organizationId) {
            return { data: [], total: 0 };
        }

        try {
            const queryBuilder =
                this.automationExecutionRepository.createQueryBuilder(
                    'automation_execution',
                );

            // LEFT JOIN: CLI reviews may be created without a teamAutomation
            // (the use case spreads it conditionally), so an INNER JOIN would
            // silently drop those rows. We scope by organization through
            // dataExecution.organizationAndTeamData.organizationId for rows
            // without a teamAutomation, and through team.organization.uuid
            // for the joined ones.
            queryBuilder
                .select([
                    'automation_execution.uuid',
                    'automation_execution.createdAt',
                    'automation_execution.updatedAt',
                    'automation_execution.status',
                    'automation_execution.errorMessage',
                    'automation_execution.origin',
                    'automation_execution.repositoryId',
                    'automation_execution.dataExecution',
                    'teamAutomation.uuid',
                    'team.uuid',
                    'team.name',
                ])
                .leftJoin(
                    'automation_execution.teamAutomation',
                    'teamAutomation',
                )
                .leftJoin('teamAutomation.team', 'team')
                .leftJoin('team.organization', 'organization')
                .where('automation_execution.origin = :origin', {
                    origin: 'cli',
                })
                .andWhere(
                    `(organization.uuid = :organizationId
                     OR "automation_execution"."dataExecution"->'organizationAndTeamData'->>'organizationId' = :organizationId::text)`,
                    { organizationId },
                );

            if (teamId) {
                queryBuilder.andWhere(
                    `(team.uuid = :teamId
                     OR "automation_execution"."dataExecution"->'organizationAndTeamData'->>'teamId' = :teamId::text)`,
                    { teamId },
                );
            }

            if (repositoryId) {
                queryBuilder.andWhere(
                    'automation_execution.repositoryId = :repositoryId',
                    { repositoryId },
                );
            }

            if (userEmail) {
                queryBuilder.andWhere(
                    `"automation_execution"."dataExecution"->>'userEmail' = :userEmail`,
                    { userEmail },
                );
            }

            if (since) {
                queryBuilder.andWhere(
                    'automation_execution.createdAt >= :since',
                    { since },
                );
            }

            let total = 0;
            if (includeTotal) {
                total = await queryBuilder.getCount();

                if (total === 0) {
                    return { data: [], total: 0 };
                }
            }

            const executions = await queryBuilder
                .orderBy('automation_execution.createdAt', order)
                .skip(skip)
                .take(take)
                .getMany();

            const mapped =
                (mapSimpleModelsToEntities(
                    executions,
                    AutomationExecutionEntity,
                ) as AutomationExecutionEntity[]) ?? [];

            return { data: mapped, total };
        } catch (error) {
            this.logger.error({
                message: 'Failed to find CLI review executions by organization',
                context: AutomationExecutionRepository.name,
                error,
                metadata: { params },
            });
            return { data: [], total: 0 };
        }
    }

    async findLatestExecutionByFilters(
        filters?: Partial<any>,
    ): Promise<AutomationExecutionEntity | null> {
        try {
            const queryBuilder =
                this.automationExecutionRepository.createQueryBuilder(
                    'automation_execution',
                );

            let result: AutomationExecutionModel | null = null;

            if (filters) {
                Object.keys(filters).forEach((key) => {
                    const value =
                        typeof filters[key] === 'object' && filters[key]?.uuid
                            ? filters[key].uuid
                            : filters[key];

                    queryBuilder.andWhere(
                        `automation_execution.${key} = :${key}`,
                        { [key]: value },
                    );
                });

                result = await queryBuilder
                    .orderBy('automation_execution.createdAt', 'DESC')
                    .getOne();
            }

            return mapSimpleModelToEntity(result, AutomationExecutionEntity);
        } catch (error) {
            this.logger.error({
                message: 'Failed to find latest execution by filters',
                context: AutomationExecutionRepository.name,
                error,
                metadata: { filters },
            });
        }
    }

    async findByPeriodAndTeamAutomationId(
        startDate: Date,
        endDate: Date,
        teamAutomationId: string,
        status?: string | string[],
    ): Promise<AutomationExecutionEntity[]> {
        try {
            const queryBuilder =
                this.automationExecutionRepository.createQueryBuilder(
                    'automation_execution',
                );
            queryBuilder.where(
                'automation_execution.createdAt BETWEEN :startDate AND :endDate',
                { startDate, endDate },
            );
            queryBuilder.andWhere(
                'automation_execution.team_automation_id = :teamAutomationId',
                { teamAutomationId },
            );

            if (status) {
                if (Array.isArray(status)) {
                    queryBuilder.andWhere(
                        'automation_execution.status IN (:...statuses)',
                        {
                            statuses: status,
                        },
                    );
                } else {
                    queryBuilder.andWhere(
                        'automation_execution.status = :status',
                        {
                            status,
                        },
                    );
                }
            }

            const result = await queryBuilder.getMany();
            return mapSimpleModelsToEntities(result, AutomationExecutionEntity);
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to find automation executions by period and team automation id',
                context: AutomationExecutionRepository.name,
                error,
                metadata: { startDate, endDate, teamAutomationId, status },
            });
        }
    }

    async findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId(
        startDate: Date,
        endDate: Date,
        teamAutomationId: string,
    ): Promise<Array<{ repositoryId: string; pullRequestNumber: number }>> {
        try {
            const queryBuilder =
                this.automationExecutionRepository.createQueryBuilder(
                    'success',
                );

            const successRepositoryExpr = '"success"."repositoryId"';
            const successPullRequestExpr = '"success"."pullRequestNumber"';

            const inProgressRepositoryExpr = '"in_progress"."repositoryId"';
            const inProgressPullRequestExpr =
                '"in_progress"."pullRequestNumber"';

            const inProgressSubquery = queryBuilder
                .subQuery()
                .select('1')
                .from(AutomationExecutionModel, 'in_progress')
                .where('in_progress.team_automation_id = :teamAutomationId')
                .andWhere('in_progress.status = :inProgressStatus')
                .andWhere(`${inProgressRepositoryExpr} IS NOT NULL`)
                .andWhere(`${inProgressPullRequestExpr} IS NOT NULL`)
                .andWhere(
                    `${inProgressRepositoryExpr} = ${successRepositoryExpr}`,
                )
                .andWhere(
                    `${inProgressPullRequestExpr} = ${successPullRequestExpr}`,
                )
                .getQuery();

            const result = await queryBuilder
                .select(successRepositoryExpr, 'repositoryId')
                .addSelect(successPullRequestExpr, 'pullRequestNumber')
                .where('success.createdAt BETWEEN :startDate AND :endDate')
                .andWhere('success.team_automation_id = :teamAutomationId')
                .andWhere('success.status = :successStatus')
                .andWhere(`${successRepositoryExpr} IS NOT NULL`)
                .andWhere(`${successPullRequestExpr} IS NOT NULL`)
                .andWhere(`NOT EXISTS (${inProgressSubquery})`)
                .groupBy(successRepositoryExpr)
                .addGroupBy(successPullRequestExpr)
                .setParameters({
                    startDate,
                    endDate,
                    teamAutomationId,
                    successStatus: AutomationStatus.SUCCESS,
                    inProgressStatus: AutomationStatus.IN_PROGRESS,
                })
                .getRawMany<{
                    repositoryId: string;
                    pullRequestNumber: number | string;
                }>();

            return (result ?? [])
                .map((item) => ({
                    repositoryId: item.repositoryId,
                    pullRequestNumber: Number(item.pullRequestNumber),
                }))
                .filter(
                    (item) =>
                        !!item.repositoryId &&
                        Number.isInteger(item.pullRequestNumber),
                );
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to find eligible pull request refs for approval by period and team automation id',
                context: AutomationExecutionRepository.name,
                error,
                metadata: { startDate, endDate, teamAutomationId },
            });
            return [];
        }
    }

    private getFilterConditions(
        filter: Partial<IAutomationExecution>,
    ): FindOptionsWhere<AutomationExecutionModel> {
        const { teamAutomation, codeReviewExecutions, ...restFilter } =
            filter || {};

        const teamAutomationCondition = createNestedConditions(
            'teamAutomation',
            teamAutomation,
        );
        const codeReviewExecutionsCondition = createNestedConditions(
            'codeReviewExecutions',
            codeReviewExecutions,
        );

        return {
            ...restFilter,
            ...codeReviewExecutionsCondition,
            ...teamAutomationCondition,
        };
    }
}
