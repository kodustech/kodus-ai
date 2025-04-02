import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { IIntegration } from '../../integrations/interfaces/integration.interface';
import { IIntegrationConfig } from '../interfaces/integration-config.interface';
import { ITeam } from '../../team/interfaces/team.interface';

export class IntegrationConfigEntity implements IIntegrationConfig {
    private _uuid: string;
    private _configKey: IntegrationConfigKey;
    private _configValue: any;
    private _integration?: Partial<IIntegration>;
    private _team?: Partial<ITeam>;

    constructor(
        integrationConfig: IIntegrationConfig | Partial<IIntegrationConfig>,
    ) {
        this._uuid = integrationConfig.uuid;
        this._configKey = integrationConfig.configKey;
        this._configValue = integrationConfig.configValue;
        this._integration = integrationConfig.integration;
        this._team = integrationConfig.team;
    }

    public static create(
        integrationConfig: IIntegrationConfig | Partial<IIntegrationConfig>,
    ) {
        return new IntegrationConfigEntity(integrationConfig);
    }

    public get uuid() {
        return this._uuid;
    }

    public get configKey() {
        return this._configKey;
    }

    public get configValue() {
        return this._configValue;
    }

    public get integration() {
        return this._integration;
    }

    public get team() {
        return this._team;
    }
}
