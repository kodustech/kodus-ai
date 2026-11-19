import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { IParametersRepository } from './parameters.repository.contracts';
import { ParametersEntity } from '../entities/parameters.entity';

export const PARAMETERS_SERVICE_TOKEN = Symbol.for('ParametersService');

export interface IParametersService extends IParametersRepository {
    createOrUpdateConfig<K extends ParametersKey>(
        parametersKey: K,
        configValue: ParametersEntity<K>['configValue'],
        organizationAndTeamData: OrganizationAndTeamData,
        expectedConfigId?: string,
    ): Promise<ParametersEntity<K> | boolean>;
}
