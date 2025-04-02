import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { IIntegration } from '../interfaces/integration.interface';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IOrganization } from '../../organization/interfaces/organization.interface';
import { IAuthIntegration } from '../../authIntegrations/interfaces/auth-integration.interface';
import { IIntegrationConfig } from '@/core/domain/integrationConfigs/interfaces/integration-config.interface';

export class IntegrationEntity implements IIntegration {
    private _uuid: string;
    private _platform: PlatformType;
    private _integrationCategory: IntegrationCategory;
    private _status: boolean;
    private _organization?: Partial<IOrganization>;
    private _authIntegration?: Partial<IAuthIntegration>;
    private _integrationConfigs?: Partial<IIntegrationConfig>[];

    constructor(integration: IIntegration | Partial<IIntegration>) {
        this._uuid = integration.uuid;
        this._platform = integration.platform;
        this._integrationCategory = integration.integrationCategory;
        this._status = integration.status;
        this._organization = integration.organization;
        this._authIntegration = integration.authIntegration;
        this._integrationConfigs = integration.integrationConfigs;
    }

    public static create(
        integration: IIntegration | Partial<IIntegration>,
    ): IntegrationEntity {
        return new IntegrationEntity(integration);
    }

    public get uuid() {
        return this._uuid;
    }

    public get platform() {
        return this._platform;
    }

    public get integrationCategory() {
        return this._integrationCategory;
    }

    public get status() {
        return this._status;
    }

    public get organization() {
        return this._organization;
    }

    public get authIntegration() {
        return this._authIntegration;
    }

    public get integrationConfigs() {
        return this._integrationConfigs;
    }
}
