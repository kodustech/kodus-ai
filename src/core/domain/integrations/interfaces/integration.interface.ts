import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IOrganization } from '../../organization/interfaces/organization.interface';
import { IAuthIntegration } from '../../authIntegrations/interfaces/auth-integration.interface';
import { IIntegrationConfig } from '@/core/domain/integrationConfigs/interfaces/integration-config.interface';
import { ITeam } from '../../team/interfaces/team.interface';

export interface IIntegration {
    uuid: string;
    platform: PlatformType;
    integrationCategory: IntegrationCategory;
    status: boolean;
    organization?: Partial<IOrganization>;
    team?: Partial<ITeam>;
    authIntegration?: Partial<IAuthIntegration>;
    integrationConfigs?: Partial<IIntegrationConfig>[];
}
