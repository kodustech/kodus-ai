import { GlobalParametersEntity } from '../entities/global-parameters.entity';
import { IGlobalParameters } from '../interfaces/global-parameters.interface';
import { GlobalParametersKey } from '@/shared/domain/enums/global-parameters-key.enum';

export const GLOBAL_PARAMETERS_REPOSITORY_TOKEN = Symbol(
    'GlobalParametersRepository',
);

export interface IGlobalParametersRepository {
    find(
        filter?: Partial<IGlobalParameters>,
    ): Promise<GlobalParametersEntity[]>;
    findOne(
        filter?: Partial<IGlobalParameters>,
    ): Promise<GlobalParametersEntity>;
    findById(uuid: string): Promise<GlobalParametersEntity | undefined>;
    create(
        globalParameter: IGlobalParameters,
    ): Promise<GlobalParametersEntity | undefined>;
    update(
        filter: Partial<IGlobalParameters>,
        data: Partial<IGlobalParameters>,
    ): Promise<GlobalParametersEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findByKey(configKey: GlobalParametersKey): Promise<GlobalParametersEntity>;
}
