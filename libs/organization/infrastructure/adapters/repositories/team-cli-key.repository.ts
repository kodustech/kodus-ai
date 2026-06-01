import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TeamCliKeyModel } from './schemas/team-cli-key.model';
import { ITeamCliKeyRepository } from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.repository.contract';
import { TeamCliKeyEntity } from '@libs/organization/domain/team-cli-key/entities/team-cli-key.entity';
import { ITeamCliKey } from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@libs/core/infrastructure/repositories/mappers';

@Injectable()
export class TeamCliKeyDatabaseRepository implements ITeamCliKeyRepository {
    constructor(
        @InjectRepository(TeamCliKeyModel)
        private readonly teamCliKeyRepository: Repository<TeamCliKeyModel>,
    ) {}

    async find(filter?: Partial<ITeamCliKey>): Promise<TeamCliKeyEntity[]> {
        try {
            const { team, createdBy, ...otherAttributes } = filter || {};

            const keys = await this.teamCliKeyRepository.find({
                where: {
                    ...otherAttributes,
                    team: team ? { uuid: team.uuid } : undefined,
                    createdBy: createdBy ? { uuid: createdBy.uuid } : undefined,
                },
                relations: ['team', 'team.organization', 'createdBy'],
            });

            return mapSimpleModelsToEntities(keys, TeamCliKeyEntity);
        } catch (error) {
            throw new Error('Erro   r finding team CLI keys', { cause: error });
        }
    }

    async findOne(
        filter: Partial<ITeamCliKey>,
    ): Promise<TeamCliKeyEntity | undefined> {
        try {
            const { team, createdBy, ...otherAttributes } = filter;

            const key = await this.teamCliKeyRepository.findOne({
                where: {
                    ...otherAttributes,
                    team: team ? { uuid: team.uuid } : undefined,
                    createdBy: createdBy ? { uuid: createdBy.uuid } : undefined,
                },
                relations: ['team', 'team.organization', 'createdBy'],
            });

            return key
                ? mapSimpleModelToEntity(key, TeamCliKeyEntity)
                : undefined;
        } catch (error) {
            throw new Error('Error finding team CLI key by filter', {
                cause: error,
            });
        }
    }

    async findById(uuid: string): Promise<TeamCliKeyEntity | undefined> {
        return this.findOne({ uuid });
    }

    async findByTeamId(teamId: string): Promise<TeamCliKeyEntity[]> {
        return this.find({ team: { uuid: teamId } as any });
    }

    async create(
        data: Partial<ITeamCliKey>,
    ): Promise<TeamCliKeyEntity | undefined> {
        try {
            const key = this.teamCliKeyRepository.create({
                name: data.name,
                keyHash: data.keyHash,
                keyPrefix: data.keyPrefix,
                active: data.active ?? true,
                config: data.config ?? {},
                team: data.team ? ({ uuid: data.team.uuid } as any) : undefined,
                createdBy: data.createdBy
                    ? ({ uuid: data.createdBy.uuid } as any)
                    : undefined,
            });

            const savedKey = await this.teamCliKeyRepository.save(key);

            return mapSimpleModelToEntity(savedKey, TeamCliKeyEntity);
        } catch (error) {
            throw new Error('Error creating team CLI key', { cause: error });
        }
    }

    async update(
        filter: Partial<ITeamCliKey>,
        data: Partial<ITeamCliKey>,
    ): Promise<TeamCliKeyEntity | undefined> {
        try {
            const key = await this.teamCliKeyRepository.findOne({
                where: filter as any,
            });

            if (!key) {
                return undefined;
            }

            Object.assign(key, data);
            const updatedKey = await this.teamCliKeyRepository.save(key);

            return mapSimpleModelToEntity(updatedKey, TeamCliKeyEntity);
        } catch (error) {
            throw new Error('Error updating team CLI key', { cause: error });
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.teamCliKeyRepository.delete({ uuid });
        } catch (error) {
            throw new Error('Error deleting team CLI key', { cause: error });
        }
    }
}
