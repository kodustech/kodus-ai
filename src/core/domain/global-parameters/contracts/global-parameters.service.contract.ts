import { IGlobalParametersRepository } from './global-parameters.repository.contracts';
import { GlobalParametersKey } from '@/shared/domain/enums/global-parameters-key.enum';
import { GlobalParametersEntity } from '../entities/global-parameters.entity';

export const GLOBAL_PARAMETERS_SERVICE_TOKEN = Symbol(
    'GlobalParametersService',
);

export interface IGlobalParametersService extends IGlobalParametersRepository {
    createOrUpdateConfig(
        parametersKey: GlobalParametersKey,
        configValue: any,
    ): Promise<GlobalParametersEntity | boolean>;
}
