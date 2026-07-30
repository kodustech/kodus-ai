import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';

import { ICodeReviewExecutionRepository } from '@libs/automation/domain/codeReviewExecutions/contracts/codeReviewExecution.repository.contract';
import { CodeReviewExecutionEntity } from '@libs/automation/domain/codeReviewExecutions/entities/codeReviewExecution.entity';
import { CodeReviewExecution } from '@libs/automation/domain/codeReviewExecutions/interfaces/codeReviewExecution.interface';
import { createLogger } from '@libs/core/log/logger';
import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@libs/core/infrastructure/repositories/mappers';
import { createNestedConditions } from '@libs/core/infrastructure/repositories/model/filters';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';

import { CodeReviewExecutionModel } from './schemas/codeReviewExecution.model';

@Injectable()
export class CodeReviewExecutionRepository<
    T,
> implements ICodeReviewExecutionRepository<T> {
    private readonly logger = createLogger(CodeReviewExecutionRepository.name);

    constructor(
        @InjectRepository(CodeReviewExecutionModel)
        private readonly codeReviewExecutionRepository: Repository<CodeReviewExecutionModel>,
    ) {}

    async create(
        codeReviewExecution: Omit<
            CodeReviewExecution<T>,
            'uuid' | 'createdAt' | 'updatedAt'
        >,
    ): Promise<CodeReviewExecutionEntity<T> | null> {
        try {
            const newObj =
                this.codeReviewExecutionRepository.create(codeReviewExecution);

            if (!newObj) {
                this.logger.warn({
                    message: 'Failed to create code review execution model',
                    context: CodeReviewExecutionRepository.name,
                    metadata: { codeReviewExecution },
                });

                return null;
            }

            const saved = await this.codeReviewExecutionRepository.save(newObj);

            if (!saved) {
                this.logger.warn({
                    message: 'Failed to save code review execution model',
                    context: CodeReviewExecutionRepository.name,
                    metadata: { codeReviewExecution },
                });

                return null;
            }

            return mapSimpleModelToEntity(saved, CodeReviewExecutionEntity);
        } catch (error) {
            this.logger.error({
                message: 'Error creating code review execution',
                error,
                context: CodeReviewExecutionRepository.name,
                metadata: { codeReviewExecution },
            });

            return null;
        }
    }

    async update(
        filter: Partial<CodeReviewExecution<T>>,
        codeReviewExecution: Partial<
            Omit<CodeReviewExecution<T>, 'uuid' | 'createdAt' | 'updatedAt'>
        >,
    ): Promise<CodeReviewExecutionEntity<T> | null> {
        try {
            const conditions = this.getFilterConditions(filter);

            const update = await this.codeReviewExecutionRepository.update(
                conditions,
                codeReviewExecution,
            );

            if (update.affected === 0) {
                this.logger.warn({
                    message: `No code review execution updated`,
                    context: CodeReviewExecutionRepository.name,
                    metadata: { conditions, codeReviewExecution },
                });
                return null;
            }

            const updated = await this.codeReviewExecutionRepository.findOne({
                where: conditions,
            });

            if (!updated) {
                this.logger.warn({
                    message: `No code review execution found after update`,
                    context: CodeReviewExecutionRepository.name,
                    metadata: { conditions, codeReviewExecution },
                });
                return null;
            }

            return mapSimpleModelToEntity(updated, CodeReviewExecutionEntity);
        } catch (error) {
            this.logger.error({
                message: 'Error updating code review execution',
                error,
                context: CodeReviewExecutionRepository.name,
                metadata: { filter, codeReviewExecution },
            });

            return null;
        }
    }

    async find(
        filter?: Partial<CodeReviewExecution<T>>,
    ): Promise<CodeReviewExecutionEntity<T>[]> {
        try {
            const conditions = this.getFilterConditions(filter);

            const found = await this.codeReviewExecutionRepository.find({
                where: conditions,
            });

            if (!found || found.length === 0) {
                this.logger.warn({
                    message: 'No code review executions found',
                    context: CodeReviewExecutionRepository.name,
                    metadata: { filter },
                });

                return [];
            }

            return mapSimpleModelsToEntities(found, CodeReviewExecutionEntity);
        } catch (error) {
            this.logger.error({
                message: 'Error finding code review executions',
                error,
                context: CodeReviewExecutionRepository.name,
                metadata: { filter },
            });

            return [];
        }
    }

    async findOne(
        filter?: Partial<CodeReviewExecution<T>>,
    ): Promise<CodeReviewExecutionEntity<T> | null> {
        try {
            const conditions = this.getFilterConditions(filter);

            const found = await this.codeReviewExecutionRepository.findOne({
                where: conditions,
            });

            if (!found) {
                this.logger.warn({
                    message: 'Code review execution not found',
                    context: CodeReviewExecutionRepository.name,
                    metadata: { filter },
                });

                return null;
            }

            return mapSimpleModelToEntity(found, CodeReviewExecutionEntity);
        } catch (error) {
            this.logger.error({
                message: 'Error finding code review execution',
                error,
                context: CodeReviewExecutionRepository.name,
                metadata: { filter },
            });

            return null;
        }
    }

    async findManyByAutomationExecutionIds(
        uuids: string[],
        options?: {
            visibility?: string;
        },
    ): Promise<CodeReviewExecutionEntity<T>[]> {
        if (!uuids.length) {
            return [];
        }

        try {
            const qb = this.codeReviewExecutionRepository
                .createQueryBuilder('codeReviewExecution')
                .leftJoin(
                    'codeReviewExecution.automationExecution',
                    'automationExecution',
                )
                .select([
                    'codeReviewExecution.uuid',
                    'codeReviewExecution.createdAt',
                    'codeReviewExecution.updatedAt',
                    'codeReviewExecution.status',
                    'codeReviewExecution.stageName',
                    'codeReviewExecution.message',
                    'codeReviewExecution.metadata',
                    'codeReviewExecution.finishedAt',
                    'automationExecution.uuid',
                ])
                .where('automationExecution.uuid IN (:...uuids)', { uuids });

            if (options?.visibility) {
                qb.andWhere(
                    "(codeReviewExecution.metadata ->> 'visibility' IS NULL OR codeReviewExecution.metadata ->> 'visibility' = :visibility)",
                    { visibility: options.visibility },
                );
            }

            qb.orderBy('codeReviewExecution.createdAt', 'ASC');

            const found = await qb.getMany();

            return mapSimpleModelsToEntities(found, CodeReviewExecutionEntity);
        } catch (error) {
            this.logger.error({
                message:
                    'Error finding code review executions by automation ids',
                error,
                context: CodeReviewExecutionRepository.name,
                metadata: { uuids },
            });
            return [];
        }
    }

    async existsByAutomationExecutionAndStageStatus(
        executionId: string,
        stageNames: string[],
        statuses: AutomationStatus[],
    ): Promise<boolean> {
        if (!executionId || stageNames.length === 0 || statuses.length === 0) {
            return false;
        }

        try {
            const found = await this.codeReviewExecutionRepository
                .createQueryBuilder('codeReviewExecution')
                .innerJoin(
                    'codeReviewExecution.automationExecution',
                    'automationExecution',
                )
                .select('1')
                .where('automationExecution.uuid = :executionId', {
                    executionId,
                })
                .andWhere('codeReviewExecution.stageName IN (:...stageNames)', {
                    stageNames,
                })
                .andWhere('codeReviewExecution.status IN (:...statuses)', {
                    statuses,
                })
                .limit(1)
                .getRawOne();

            return Boolean(found);
        } catch (error) {
            this.logger.error({
                message:
                    'Error checking code review execution stage status existence',
                error,
                context: CodeReviewExecutionRepository.name,
                metadata: { executionId, stageNames, statuses },
            });
            return false;
        }
    }

    async delete(uuid: string): Promise<boolean> {
        try {
            const res = await this.codeReviewExecutionRepository.delete({
                uuid,
            });

            return res.affected > 0;
        } catch (error) {
            this.logger.error({
                message: 'Error deleting code review execution',
                error,
                context: CodeReviewExecutionRepository.name,
                metadata: { uuid },
            });

            return false;
        }
    }

    private getFilterConditions(
        filter: Partial<CodeReviewExecution<T>>,
    ): FindOptionsWhere<CodeReviewExecutionModel> {
        const { automationExecution, ...restFilter } = filter || {};

        const automationExecutionCondition = createNestedConditions(
            'automationExecution',
            automationExecution,
        );

        return {
            ...restFilter,
            ...automationExecutionCondition,
        };
    }
}
