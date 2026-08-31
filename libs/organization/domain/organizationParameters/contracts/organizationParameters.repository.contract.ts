import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationParametersEntity } from '../entities/organizationParameters.entity';
import { IOrganizationParameters } from '../interfaces/organizationParameters.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export const ORGANIZATION_PARAMETERS_REPOSITORY_TOKEN = Symbol(
    'OrganizationParametersRepository',
);

export interface IOrganizationParametersRepository {
    find(
        filter?: Partial<IOrganizationParameters>,
    ): Promise<OrganizationParametersEntity[]>;
    findOne(
        filter?: Partial<IOrganizationParameters>,
    ): Promise<OrganizationParametersEntity>;
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
    compareAndSwapConfigValue(
        uuid: string,
        expected: IOrganizationParameters['configValue'],
        replacement: IOrganizationParameters['configValue'],
    ): Promise<boolean>;
    delete(uuid: string): Promise<void>;
    findByKey(
        configKey: OrganizationParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity>;
    findByKeyAndValue(filter: {
        configKey: OrganizationParametersKey;
        configValue: any;
        organizationAndTeamData?: OrganizationAndTeamData;
        fuzzy?: boolean;
    }): Promise<OrganizationParametersEntity[]>;
}
