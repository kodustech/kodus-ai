import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IOrganizationParameters } from '../interfaces/organizationParameters.interface';
import { OrganizationParametersEntity } from '../entities/organizationParameters.entity';
import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';

export const ORGANIZATION_PARAMETERS_REPOSITORY_TOKEN = Symbol('OrganizationParametersRepository');

export interface IOrganizationParametersRepository {
    find(filter?: Partial<IOrganizationParameters>): Promise<OrganizationParametersEntity[]>;
    findOne(filter?: Partial<IOrganizationParameters>): Promise<OrganizationParametersEntity>;
    findById(uuid: string): Promise<OrganizationParametersEntity | undefined>;
    findByOrganizationName(
        organizationName: string,
    ): Promise<OrganizationParametersEntity | undefined>;
    create(
        integrationConfig: IOrganizationParameters,
    ): Promise<OrganizationParametersEntity | undefined>;
    update(
        filter: Partial<IOrganizationParameters>,
        data: Partial<IOrganizationParameters>,
    ): Promise<OrganizationParametersEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findByKey(
        configKey: OrganizationParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity>;
}
