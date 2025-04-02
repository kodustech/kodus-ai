import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { IIntegration } from '../../integrations/interfaces/integration.interface';
import { ITeam } from '../../team/interfaces/team.interface';

export interface IIntegrationConfig {
    uuid: string;
    configKey: IntegrationConfigKey;
    configValue: any;
    integration?: Partial<IIntegration>;
    team?: Partial<ITeam>;
}
