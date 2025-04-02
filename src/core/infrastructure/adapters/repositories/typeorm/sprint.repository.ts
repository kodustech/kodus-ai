import {
    FindManyOptions,
    FindOneOptions,
    FindOptions,
    Repository,
} from 'typeorm';
import { SprintModel } from './schema/sprint.model';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { SprintEntity } from '@/core/domain/sprint/entities/sprint.entity';
import { ISprint } from '@/core/domain/sprint/interface/sprint.interface';
import { ISprintRepository } from '@/core/domain/sprint/contracts/sprint.repository.contracts';
import { COMPILE_STATE } from '@/core/domain/sprint/enum/compileState.enum';

@Injectable()
export class SprintRepository implements ISprintRepository {
    constructor(
        @InjectRepository(SprintModel)
        private readonly sprintRepository: Repository<SprintModel>,
    ) {}

    async findOne(filter?: Partial<ISprint>): Promise<SprintEntity> {
        const whereConditions: any = { ...filter };

        const findOneOptions: FindOneOptions<SprintModel> = {
            where: {
                ...whereConditions,
            },
            relations: ['team'],
        };

        const sprintSelected =
            await this.sprintRepository.findOne(findOneOptions);

        if (!sprintSelected) return undefined;

        return mapSimpleModelToEntity(sprintSelected, SprintEntity);
    }
    update(
        filter: Partial<ISprint>,
        data: Partial<ISprint>,
    ): Promise<SprintEntity> {
        throw new Error('Method not implemented.');
    }

    async find(
        filter: Partial<ISprint>,
        options?: FindManyOptions,
    ): Promise<SprintEntity[]> {
        try {
            const whereConditions: any = { ...filter };

            const findManyOptions: FindManyOptions<SprintModel> = {
                where: {
                    ...whereConditions,
                },
                relations: ['team'],
                ...options,
            } as FindManyOptions<SprintModel>;

            const sprintModel =
                await this.sprintRepository.find(findManyOptions);

            return mapSimpleModelsToEntities(sprintModel, SprintEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<SprintEntity> {
        try {
            if (!uuid) return undefined;

            const findOneOptions: FindOneOptions<SprintModel> = {
                where: {
                    uuid,
                },
                relations: ['team'],
            };

            const sprintSelected =
                await this.sprintRepository.findOne(findOneOptions);

            if (!sprintSelected) return undefined;

            return mapSimpleModelToEntity(sprintSelected, SprintEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async create(sprintEntity: ISprint): Promise<SprintEntity> {
        try {
            const queryBuilder =
                this.sprintRepository.createQueryBuilder('sprint');

            const automationExecutionModel =
                this.sprintRepository.create(sprintEntity);

            const automationExecutionCreated = await queryBuilder
                .insert()
                .values(automationExecutionModel)
                .execute();

            if (automationExecutionCreated?.identifiers[0]?.uuid) {
                const findOneOptions: FindOneOptions<SprintModel> = {
                    where: {
                        uuid: automationExecutionCreated.identifiers[0].uuid,
                    },
                };

                const selectedAutomationExecution =
                    await this.sprintRepository.findOne(findOneOptions);

                if (!selectedAutomationExecution) return undefined;

                return mapSimpleModelToEntity(
                    selectedAutomationExecution,
                    SprintEntity,
                );
            }

            return undefined;
        } catch (error) {
            console.log(error);
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.sprintRepository.delete(uuid);
        } catch (error) {
            console.log(error);
        }
    }

    async createOrUpdateSprintValue(
        organizationAndTeamData,
        sprintEntity: ISprint,
    ) {
        try {
            const queryBuilder =
                this.sprintRepository.createQueryBuilder('sprint');

            const existingSprint = await this.sprintRepository.findOne({
                where: {
                    projectManagementSprintId:
                        sprintEntity.projectManagementSprintId,
                },
            });

            // caso exista sprint no banco, apenas atualiza o valor
            if (existingSprint) {
                const sprint = await queryBuilder
                    .update()
                    .set({
                        name: sprintEntity.name,
                        value: sprintEntity.value,
                        startDate: sprintEntity.startDate,
                        compileState: sprintEntity.compileState,
                        completeDate: sprintEntity.completeDate,
                        description: sprintEntity.description,
                        endDate: sprintEntity.endDate,
                        state: sprintEntity.state,
                        goal: sprintEntity.goal,
                    })
                    .execute();

                return sprint;
            } else {
                sprintEntity.team = {
                    uuid: organizationAndTeamData.teamId,
                };

                const sprintModel =
                    await this.sprintRepository.create(sprintEntity);

                const sprint = await queryBuilder
                    .insert()
                    .values(sprintModel)
                    .execute();

                return sprint;
            }
        } catch (error) {
            console.log(error);
        }
    }
}
