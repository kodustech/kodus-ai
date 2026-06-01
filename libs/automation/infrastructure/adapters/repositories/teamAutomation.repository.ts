import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    FindManyOptions,
    FindOneOptions,
    Repository,
    UpdateQueryBuilder,
} from 'typeorm';

import { ITeamAutomationRepository } from '@libs/automation/domain/teamAutomation/contracts/team-automation.repository';
import { TeamAutomationEntity } from '@libs/automation/domain/teamAutomation/entities/team-automation.entity';
import { ITeamAutomation } from '@libs/automation/domain/teamAutomation/interfaces/team-automation.interface';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@libs/core/infrastructure/repositories/mappers';
import { createNestedConditions } from '@libs/core/infrastructure/repositories/model/filters';

import { TeamAutomationModel } from './schemas/teamAutomation.model';

@Injectable()
export class TeamAutomationRepository implements ITeamAutomationRepository {
    private readonly logger = createLogger(TeamAutomationRepository.name);

    constructor(
        @InjectRepository(TeamAutomationModel)
        private readonly teamAutomationRepository: Repository<TeamAutomationModel>,
    ) {}

    async create(
        teamAutomation: ITeamAutomation,
    ): Promise<TeamAutomationEntity> {
        try {
            const queryBuilder =
                this.teamAutomationRepository.createQueryBuilder(
                    'teamAutomation',
                );

            const teamAutomationModel =
                this.teamAutomationRepository.create(teamAutomation);

            const teamAutomationCreated = await queryBuilder
                .insert()
                .values(teamAutomationModel)
                .execute();

            if (teamAutomationCreated) {
                if (!teamAutomationCreated?.identifiers[0]?.uuid)
                    return undefined;

                const findOneOptions: FindOneOptions<TeamAutomationModel> = {
                    where: {
                        uuid: teamAutomationCreated.identifiers[0].uuid,
                    },
                };

                const selectedTeamAutomationModel =
                    await this.teamAutomationRepository.findOne(findOneOptions);

                if (!selectedTeamAutomationModel) return undefined;

                return mapSimpleModelToEntity(
                    selectedTeamAutomationModel,
                    TeamAutomationEntity,
                );
            }
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<ITeamAutomation>,
        data: Partial<ITeamAutomation>,
    ): Promise<TeamAutomationEntity> {
        try {
            const queryBuilder: UpdateQueryBuilder<TeamAutomationModel> =
                this.teamAutomationRepository
                    .createQueryBuilder('teamAutomation')
                    .update(TeamAutomationModel)
                    .set(data)
                    .where(filter);

            const automationSelected = await queryBuilder.execute();

            if (automationSelected) {
                if (!data.uuid) return undefined;

                const findOneOptions: FindOneOptions<TeamAutomationModel> = {
                    where: {
                        uuid: data.uuid,
                    },
                };

                const insertedData =
                    await this.teamAutomationRepository.findOne(findOneOptions);

                if (insertedData) {
                    return mapSimpleModelToEntity(
                        insertedData,
                        TeamAutomationEntity,
                    );
                }
            }
        } catch (error) {
            console.log(error);
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.teamAutomationRepository.delete(uuid);
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<TeamAutomationEntity> {
        try {
            if (!uuid) return undefined;

            const findOneOptions: FindOneOptions<TeamAutomationModel> = {
                where: {
                    uuid,
                },
                relations: ['team', 'automation'],
            };

            const automationExecutionSelected =
                await this.teamAutomationRepository.findOne(findOneOptions);

            if (!automationExecutionSelected) return undefined;

            return mapSimpleModelToEntity(
                automationExecutionSelected,
                TeamAutomationEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async find(
        filter?: Partial<ITeamAutomation>,
    ): Promise<TeamAutomationEntity[]> {
        try {
            const { team, automation, ...otherFilterAttributes }: any =
                filter || {};

            const teamCondition = createNestedConditions('team', team);

            const automationCondition = createNestedConditions(
                'automation',
                automation,
            );

            const findOneOptions: FindManyOptions<TeamAutomationModel> = {
                where: {
                    ...otherFilterAttributes,
                    ...teamCondition,
                    ...automationCondition,
                    team: {
                        status: STATUS.ACTIVE,
                    },
                },
                relations: ['team', 'team.organization', 'automation'],
            };

            const automationModel =
                await this.teamAutomationRepository.find(findOneOptions);

            // mapSimpleModelsToEntities() returns `null` (not []) when its
            // input is empty — see libs/core/.../mappers.ts:59. Callers that
            // do `const [x] = await find(...)` then explode with "is not
            // iterable" instead of getting the natural "no rows matched"
            // outcome. Coalesce here so the contract (Promise<Entity[]>) is
            // honored even on empty lookups.
            return (
                mapSimpleModelsToEntities(
                    automationModel,
                    TeamAutomationEntity,
                ) ?? []
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to find team automations',
                context: TeamAutomationRepository.name,
                error,
            });
            return [];
        }
    }
}
