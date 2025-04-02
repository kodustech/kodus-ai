import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    FindManyOptions,
    FindOneOptions,
    Repository,
    UpdateQueryBuilder,
} from 'typeorm';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { IOrganizationAutomationExecutionRepository } from '@/core/domain/automation/contracts/organization-automation-execution.repository';
import { OrganizationAutomationExecutionModel } from './schema/organizationAutomationExecution.model';
import { IOrganizationAutomationExecution } from '@/core/domain/automation/interfaces/organization-automation-execution.interface';
import { OrganizationAutomationExecutionEntity } from '@/core/domain/automation/entities/organization-automation-execution.entity';
import { PinoLoggerService } from '../../services/logger/pino.service';

@Injectable()
export class OrganizationAutomationExecutionRepository
    implements IOrganizationAutomationExecutionRepository {
    constructor(
        @InjectRepository(OrganizationAutomationExecutionModel)
        private readonly organizationAutomationExecutionRepository: Repository<OrganizationAutomationExecutionModel>,

        private readonly logger: PinoLoggerService
    ) { }

    async create(
        organizationAutomationExecution: IOrganizationAutomationExecution,
    ): Promise<OrganizationAutomationExecutionEntity> {
        try {
            const queryBuilder =
                this.organizationAutomationExecutionRepository.createQueryBuilder(
                    'organizationAutomationExecution',
                );

            const organizationAutomationExecutionModel =
                this.organizationAutomationExecutionRepository.create(organizationAutomationExecution);

            const organizationAutomationExecutionCreated = await queryBuilder
                .insert()
                .values(organizationAutomationExecutionModel)
                .execute();

            if (organizationAutomationExecutionCreated) {
                const findOneOptions: FindOneOptions<OrganizationAutomationExecutionModel> =
                {
                    where: {
                        uuid: organizationAutomationExecutionCreated.identifiers[0]
                            .uuid,
                    },
                };

                const selectedOrganizationAutomationExecution =
                    await this.organizationAutomationExecutionRepository.findOne(
                        findOneOptions,
                    );

                if (!selectedOrganizationAutomationExecution) return undefined;

                return mapSimpleModelToEntity(
                    selectedOrganizationAutomationExecution,
                    OrganizationAutomationExecutionEntity,
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing operation in the repository',
                context: OrganizationAutomationExecutionRepository.name,
                error: error,
            });

            throw new Error();
        }
    }

    async update(
        filter: Partial<IOrganizationAutomationExecution>,
        data: Partial<IOrganizationAutomationExecution>,
    ): Promise<OrganizationAutomationExecutionEntity> {
        try {
            const queryBuilder: UpdateQueryBuilder<OrganizationAutomationExecutionModel> =
                this.organizationAutomationExecutionRepository
                    .createQueryBuilder('organizationAutomationExecution')
                    .update(OrganizationAutomationExecutionModel)
                    .set(data)
                    .where('uuid = :uuid', { uuid: data.uuid });

            const organizationAutomationSelected = await queryBuilder.execute();

            if (organizationAutomationSelected && data?.uuid) {
                const findOneOptions: FindOneOptions<OrganizationAutomationExecutionModel> =
                {
                    where: {
                        uuid: data.uuid,
                    },
                };

                const insertedData =
                    await this.organizationAutomationExecutionRepository.findOne(
                        findOneOptions,
                    );

                if (!insertedData) {
                    return null;
                }

                if (insertedData) {
                    return mapSimpleModelToEntity(
                        insertedData,
                        OrganizationAutomationExecutionEntity,
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
            await this.organizationAutomationExecutionRepository.delete(uuid);
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<OrganizationAutomationExecutionEntity> {
        try {
            const queryBuilder =
                this.organizationAutomationExecutionRepository.createQueryBuilder(
                    'organizationAutomationExecution',
                );

            const organizationAutomationExecutionSelected = await queryBuilder
                .where('user.uuid = :uuid', { uuid })
                .getOne();

            return mapSimpleModelToEntity(
                organizationAutomationExecutionSelected,
                OrganizationAutomationExecutionEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async find(
        filter?: Partial<IOrganizationAutomationExecution>,
    ): Promise<OrganizationAutomationExecutionEntity[]> {
        try {
            const whereConditions: any = { ...filter };

            const findOneOptions: FindManyOptions<OrganizationAutomationExecutionModel> = {
                where: whereConditions,
            };

            const organizationAutomationModel =
                await this.organizationAutomationExecutionRepository.find(findOneOptions);

            return mapSimpleModelsToEntities(
                organizationAutomationModel,
                OrganizationAutomationExecutionEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }
}
