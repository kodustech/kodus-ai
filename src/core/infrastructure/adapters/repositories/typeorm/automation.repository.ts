import { IAutomationRepository } from '@/core/domain/automation/contracts/automation.repository';
import { IAutomation } from '@/core/domain/automation/interfaces/automation.interface';
import { Injectable } from '@nestjs/common';
import { AutomationModel } from './schema/automation.model';
import { InjectRepository } from '@nestjs/typeorm';
import {
    Any,
    FindManyOptions,
    FindOneOptions,
    In,
    Like,
    Repository,
    UpdateQueryBuilder,
} from 'typeorm';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { AutomationEntity } from '@/core/domain/automation/entities/automation.entity';

@Injectable()
export class AutomationRepository implements IAutomationRepository {
    constructor(
        @InjectRepository(AutomationModel)
        private readonly automationRepository: Repository<AutomationModel>,
    ) { }

    async findOne(filter: Partial<IAutomation>): Promise<AutomationEntity> {
        try {
            if (!filter) return undefined;

            const findOneOptions: FindOneOptions<AutomationModel> = {
                where: {
                    ...filter,
                    tags: filter.tags ? In(filter.tags) : undefined,
                    antiPatterns: filter.antiPatterns
                        ? In(filter.antiPatterns)
                        : undefined,
                },
            };

            const diagnosticAnalysisSelected =
                await this.automationRepository.findOne(findOneOptions);

            if (!diagnosticAnalysisSelected) return undefined;

            return mapSimpleModelToEntity(
                diagnosticAnalysisSelected,
                AutomationEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    create(automation: IAutomation): Promise<AutomationEntity> {
        try {
            const automationModel =
                this.automationRepository.create(automation);

            return mapSimpleModelToEntity(automationModel, AutomationEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<IAutomation>,
        data: Partial<IAutomation>,
    ): Promise<AutomationEntity> {
        try {
            const queryBuilder: UpdateQueryBuilder<AutomationModel> =
                this.automationRepository
                    .createQueryBuilder('automation')
                    .update(AutomationModel)
                    .set(data)
                    .where('uuid = :uuid', { uuid: data.uuid });

            const automationSelected = await queryBuilder.execute();

            if (automationSelected && data?.uuid) {
                const findOneOptions: FindOneOptions<AutomationModel> = {
                    where: {
                        uuid: data.uuid,
                    },
                };

                const insertedData =
                    await this.automationRepository.findOne(findOneOptions);

                if (!insertedData) {
                    return null;
                }

                if (insertedData) {
                    return mapSimpleModelToEntity(
                        insertedData,
                        AutomationEntity,
                    );
                }
            }

            return null;
        } catch (error) {
            console.log(error);
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.automationRepository.delete(uuid);
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<AutomationEntity> {
        try {
            const queryBuilder =
                this.automationRepository.createQueryBuilder('automation');

            const automationSelected = await queryBuilder
                .where('user.uuid = :uuid', { uuid })
                .getOne();

            return mapSimpleModelToEntity(automationSelected, AutomationEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async find(filter?: Partial<IAutomation>): Promise<AutomationEntity[]> {
        try {
            const whereConditions: any = { ...filter };

            if (filter?.tags && filter.tags.length > 0) {
                delete whereConditions.tags;

                whereConditions.tags = Any(
                    filter.tags.map((tag) => Like(`%${tag}%`)),
                );
            }

            if (filter?.antiPatterns && filter.antiPatterns.length > 0) {
                delete whereConditions.antiPatterns;

                whereConditions.antiPatterns = Any(
                    filter.antiPatterns.map((antiPattern) =>
                        Like(`%${antiPattern}%`),
                    ),
                );
            }

            const findOneOptions: FindManyOptions<AutomationModel> = {
                where: whereConditions,
            };

            const automationModel =
                await this.automationRepository.find(findOneOptions);

            return mapSimpleModelsToEntities(automationModel, AutomationEntity);
        } catch (error) {
            console.log(error);
        }
    }
}
