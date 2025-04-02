import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { ParametersEntity } from '../entities/parameters.entity';
import { IParameters } from '../interfaces/parameters.interface';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';

export const PARAMETERS_REPOSITORY_TOKEN = Symbol('ParametersRepository');

export interface IParametersRepository {
    find(filter?: Partial<IParameters>): Promise<ParametersEntity[]>;
    findOne(filter?: Partial<IParameters>): Promise<ParametersEntity>;
    findById(uuid: string): Promise<ParametersEntity | undefined>;
    findByOrganizationName(
        organizationName: string,
    ): Promise<ParametersEntity | undefined>;
    create(
        integrationConfig: IParameters,
    ): Promise<ParametersEntity | undefined>;
    update(
        filter: Partial<IParameters>,
        data: Partial<IParameters>,
    ): Promise<ParametersEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findByKey(
        configKey: ParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ParametersEntity>;
}
