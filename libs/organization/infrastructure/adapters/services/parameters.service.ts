import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IParametersRepository,
    PARAMETERS_REPOSITORY_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.repository.contracts';
import { IParametersService } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ParametersEntity } from '@libs/organization/domain/parameters/entities/parameters.entity';
import { IParameters } from '@libs/organization/domain/parameters/interfaces/parameters.interface';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';

@Injectable()
export class ParametersService implements IParametersService {
    constructor(
        @Inject(PARAMETERS_REPOSITORY_TOKEN)
        private readonly parametersRepository: IParametersRepository,
    ) {}

    find<K extends ParametersKey>(
        filter?: Partial<IParameters<K>>,
    ): Promise<ParametersEntity<K>[]> {
        return this.parametersRepository.find(filter);
    }

    findOne<K extends ParametersKey>(
        filter?: Partial<IParameters<K>>,
    ): Promise<ParametersEntity<K>> {
        return this.parametersRepository.findOne(filter);
    }

    findByOrganizationName<K extends ParametersKey>(
        organizationName: string,
    ): Promise<ParametersEntity<K>> {
        return this.parametersRepository.findByOrganizationName(
            organizationName,
        );
    }
    findById<K extends ParametersKey>(
        uuid: string,
    ): Promise<ParametersEntity<K>> {
        return this.parametersRepository.findById(uuid);
    }

    create<K extends ParametersKey>(
        parameters: IParameters<K>,
    ): Promise<ParametersEntity<K>> {
        return this.parametersRepository.create(parameters);
    }

    update<K extends ParametersKey>(
        filter: Partial<IParameters<K>>,
        data: Partial<IParameters<K>>,
    ): Promise<ParametersEntity<K>> {
        return this.parametersRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.parametersRepository.delete(uuid);
    }

    deleteByTeamId(teamId: string): Promise<void> {
        return this.parametersRepository.deleteByTeamId(teamId);
    }

    async findByKey<K extends ParametersKey>(
        configKey: K,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ParametersEntity<K>> {
        return this.parametersRepository.findByKey(
            configKey,
            organizationAndTeamData,
        );
    }

    createNewActiveVersion<K extends ParametersKey>(
        configKey: K,
        teamId: string,
        configValue: IParameters<K>['configValue'],
        nextVersion: number,
    ): Promise<ParametersEntity<K> | undefined> {
        return this.parametersRepository.createNewActiveVersion(
            configKey,
            teamId,
            configValue,
            nextVersion,
        );
    }

    async createOrUpdateConfig<K extends ParametersKey>(
        parametersKey: K,
        configValue: ParametersEntity<K>['configValue'],
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ParametersEntity<K> | boolean> {
        try {
            const teamId = organizationAndTeamData.teamId;

            const existingParameters = await this.findOne({
                team: { uuid: teamId },
                configKey: parametersKey,
                active: true,
            });

            const version = existingParameters
                ? existingParameters.version + 1
                : 1;

            if (parametersKey !== ParametersKey.CODE_REVIEW_CONFIG) {
                return existingParameters
                    ? this.updateExistingParameters(
                          existingParameters,
                          configValue,
                          teamId,
                      )
                    : this.createNewParameters(
                          parametersKey,
                          configValue,
                          teamId,
                          version,
                      );
            }

            // Atomic deactivate-then-insert for the versioned code review
            // config. Replaces the previous three-step find/update/insert,
            // which had no transaction boundary and was the source of the
            // "two active versions for the same team" production bug.
            // `await` is required so a QueryFailedError from the partial
            // unique index (raised when two writers race past the app-level
            // guard) propagates into the surrounding catch instead of
            // escaping as an unhandled rejection.
            return await this.parametersRepository.createNewActiveVersion(
                parametersKey,
                teamId,
                configValue,
                version,
            );
        } catch (err) {
            throw new BadRequestException('Failed to save parameters', {
                cause: err,
            });
        }
    }

    private async updateExistingParameters<K extends ParametersKey>(
        existingParameters: ParametersEntity<K>,
        configValue: ParametersEntity<K>['configValue'],
        teamId: string,
    ): Promise<boolean> {
        await this.update(
            {
                uuid: existingParameters.uuid,
                team: { uuid: teamId },
            },
            {
                configKey: existingParameters.configKey,
                configValue,
                team: { uuid: teamId },
            },
        );
        return true;
    }

    private async createNewParameters<K extends ParametersKey>(
        parametersKey: K,
        configValue: ParametersEntity<K>['configValue'],
        teamId: string,
        version: number,
    ): Promise<ParametersEntity<K>> {
        return this.create({
            uuid: uuidv4(),
            configKey: parametersKey,
            configValue,
            team: { uuid: teamId },
            active: true,
            version,
        });
    }
}
