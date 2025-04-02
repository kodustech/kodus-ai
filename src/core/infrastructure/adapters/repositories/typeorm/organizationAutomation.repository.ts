import { IOrganizationAutomationRepository } from '@/core/domain/automation/contracts/organization-automation.repository';
import { OrganizationAutomationEntity } from '@/core/domain/automation/entities/organization-automation.entity';
import { IOrganizationAutomation } from '@/core/domain/automation/interfaces/organization-automation.interface';
import { mapSimpleModelsToEntities, mapSimpleModelToEntity } from '@/shared/infrastructure/repositories/mappers';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindManyOptions, FindOneOptions, Repository, UpdateQueryBuilder } from 'typeorm';
import { OrganizationAutomationModel } from './schema/organizationAutomation.model';
import { STATUS } from '@/config/types/database/status.type';

@Injectable()
export class OrganizationAutomationRepository implements IOrganizationAutomationRepository {
    constructor(
        @InjectRepository(OrganizationAutomationModel)
        private readonly organizationAutomationRepository: Repository<OrganizationAutomationModel>,
    ) { }

    async create(
        organizationAutomation: IOrganizationAutomation,
    ): Promise<OrganizationAutomationEntity> {
        try {
            const queryBuilder =
                this.organizationAutomationRepository.createQueryBuilder(
                    'organizationAutomation',
                );

            const OrganizationAutomationModel =
                this.organizationAutomationRepository.create(organizationAutomation);

            const organizationAutomationCreated = await queryBuilder
                .insert()
                .values(OrganizationAutomationModel)
                .execute();

            if (organizationAutomationCreated) {
                if (!organizationAutomationCreated?.identifiers[0]?.uuid)
                    return undefined;

                const findOneOptions: FindOneOptions<OrganizationAutomationModel> = {
                    where: {
                        uuid: organizationAutomationCreated.identifiers[0].uuid,
                    },
                };

                const selectedOrganizationAutomationModel =
                    await this.organizationAutomationRepository.findOne(findOneOptions);

                if (!selectedOrganizationAutomationModel) return undefined;

                return mapSimpleModelToEntity(
                    selectedOrganizationAutomationModel,
                    OrganizationAutomationEntity,
                );
            }
        } catch (error) {
            console.log(error);
        }
    }

    async find(filter?: Partial<IOrganizationAutomation>): Promise<OrganizationAutomationEntity[]> {
        try {
            if (!filter) return undefined;

            const findOneOptions: FindManyOptions<OrganizationAutomationModel> = {
                where: {
                    ...(filter as any),
                },
                relations: ['organization', 'automation'],
            };

            const automationModel =
                await this.organizationAutomationRepository.find(findOneOptions);

            return mapSimpleModelsToEntities(
                automationModel,
                OrganizationAutomationEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<IOrganizationAutomation>,
        data: Partial<IOrganizationAutomation>,
    ): Promise<OrganizationAutomationEntity> {
        try {
            const queryBuilder: UpdateQueryBuilder<OrganizationAutomationModel> =
                this.organizationAutomationRepository
                    .createQueryBuilder('organizationAutomation')
                    .update(OrganizationAutomationModel)
                    .set(data)
                    .where(filter);

            const automationSelected = await queryBuilder.execute();

            if (automationSelected) {
                if (!data.uuid) return undefined;

                const findOneOptions: FindOneOptions<OrganizationAutomationModel> = {
                    where: {
                        uuid: data.uuid,
                    },
                };

                const insertedData =
                    await this.organizationAutomationRepository.findOne(findOneOptions);

                if (insertedData) {
                    return mapSimpleModelToEntity(
                        insertedData,
                        OrganizationAutomationEntity,
                    );
                }
            }
        } catch (error) {
            console.log(error);
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.organizationAutomationRepository.delete(uuid);
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<OrganizationAutomationEntity> {
        try {
            if (!uuid) return undefined;

            const findOneOptions: FindOneOptions<OrganizationAutomationModel> = {
                where: {
                    uuid,
                },
                relations: ['organization', 'automation'],
            };

            const automationExecutionSelected =
                await this.organizationAutomationRepository.findOne(findOneOptions);

            if (!automationExecutionSelected) return undefined;

            return mapSimpleModelToEntity(
                automationExecutionSelected,
                OrganizationAutomationEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

}
