import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    IParametersRepository,
    PARAMETERS_REPOSITORY_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.repository.contracts';
import { IParametersService } from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersEntity } from '@/core/domain/parameters/entities/parameters.entity';
import { IParameters } from '@/core/domain/parameters/interfaces/parameters.interface';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class ParametersService implements IParametersService {
    constructor(
        @Inject(PARAMETERS_REPOSITORY_TOKEN)
        private readonly parametersRepository: IParametersRepository,
    ) {}

    find(filter?: Partial<IParameters>): Promise<ParametersEntity[]> {
        return this.parametersRepository.find(filter);
    }

    findOne(filter?: Partial<IParameters>): Promise<ParametersEntity> {
        return this.parametersRepository.findOne(filter);
    }

    findByOrganizationName(
        organizationName: string,
    ): Promise<ParametersEntity> {
        return this.parametersRepository.findByOrganizationName(
            organizationName,
        );
    }
    findById(uuid: string): Promise<ParametersEntity> {
        return this.parametersRepository.findById(uuid);
    }

    create(parameters: IParameters): Promise<ParametersEntity> {
        return this.parametersRepository.create(parameters);
    }

    update(
        filter: Partial<IParameters>,
        data: Partial<IParameters>,
    ): Promise<ParametersEntity> {
        return this.parametersRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.parametersRepository.delete(uuid);
    }

    async findByKey(
        configKey: ParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ParametersEntity> {
        return this.parametersRepository.findByKey(
            configKey,
            organizationAndTeamData,
        );
    }

    async createOrUpdateConfig(
        parametersKey: ParametersKey,
        configValue: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ParametersEntity | boolean> {
        try {
            const parameters = await this.findOne({
                team: { uuid: organizationAndTeamData.teamId },
                configKey: parametersKey,
            });

            if (!parameters) {
                const uuid = uuidv4();

                return await this.create({
                    uuid: uuid,
                    configKey: parametersKey,
                    configValue: configValue,
                    team: { uuid: organizationAndTeamData.teamId },
                });
            } else {
                await this.update(
                    {
                        uuid: parameters?.uuid,
                        team: { uuid: organizationAndTeamData.teamId },
                    },
                    {
                        configKey: parametersKey,
                        configValue: configValue,
                        team: { uuid: organizationAndTeamData.teamId },
                    },
                );
                return true;
            }
        } catch (err) {
            throw new BadRequestException(err);
        }
    }
}
