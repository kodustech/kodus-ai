import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IOrganizationParametersRepository } from './organizationParameters.repository.contract';
import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';
import { OrganizationParametersEntity } from '../entities/organizationParameters.entity';

export const ORGANIZATION_PARAMETERS_SERVICE_TOKEN = Symbol(
    'OrganizationParametersService',
);

export interface IOrganizationParametersService
    extends IOrganizationParametersRepository {
    createOrUpdateConfig(
        organizationParametersKey: OrganizationParametersKey,
        configValue: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity | boolean>;
    createOrUpdateWorkItemsConfig(
        organizationParametersKey: OrganizationParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity>;
    findByKey(
        configKey: OrganizationParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity>;
}
