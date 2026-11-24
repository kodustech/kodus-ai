import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IOrganization } from '@libs/organization/domain/organization/interfaces/organization.interface';
import { ITeam } from '@libs/organization/domain/team/interfaces/team.interface';

import { IAuthIntegration } from '../../authIntegrations/interfaces/auth-integration.interface';
import { IIntegrationConfig } from '../../integrationConfigs/interfaces/integration-config.interface';

export interface IIntegration<TOrganization = IOrganization, TTeam = ITeam> {
    uuid: string;
    platform: PlatformType;
    integrationCategory: IntegrationCategory;
    status: boolean;
    name?: string | null;
    reviewEnabled?: boolean;
    organization?: Partial<TOrganization>;
    team?: Partial<TTeam>;
    authIntegration?: Partial<
        IAuthIntegration<IIntegration<TOrganization, TTeam>>
    >;
    integrationConfigs?: Partial<
        IIntegrationConfig<IIntegration<TOrganization, TTeam>>
    >[];
}
