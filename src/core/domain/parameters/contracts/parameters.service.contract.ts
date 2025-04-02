import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IParametersRepository } from './parameters.repository.contracts';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { ParametersEntity } from '../entities/parameters.entity';

export const PARAMETERS_SERVICE_TOKEN = Symbol('ParametersService');

export interface IParametersService extends IParametersRepository {
    createOrUpdateConfig(
        parametersKey: ParametersKey,
        configValue: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ParametersEntity | boolean>;
}
