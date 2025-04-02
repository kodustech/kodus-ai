import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { ProfileConfigKey } from '../enum/profileConfigKey.enum';
import { IProfileConfigRepository } from './profileConfig.repository.contract';
import { ProfileConfigEntity } from '../entities/profileConfig.entity';

export const PROFILE_CONFIG_SERVICE_TOKEN = Symbol('IntegrationConfigService');

export interface IProfileConfigService extends IProfileConfigRepository {
    createOrUpdateConfig(
        profileConfigKey: ProfileConfigKey,
        payload: any,
        organizationAndTeamData: OrganizationAndTeamData,
    );
    findProfileConfigFormatted<T>(
        configKey: ProfileConfigKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<T>;

    findProfileConfigOrganizationOwner(organization_id: string): Promise<ProfileConfigEntity>;
}
