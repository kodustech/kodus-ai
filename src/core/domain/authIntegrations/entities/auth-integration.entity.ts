import { IIntegration } from '../../integrations/interfaces/integration.interface';
import { IOrganization } from '../../organization/interfaces/organization.interface';
import { IAuthIntegration } from '../interfaces/auth-integration.interface';

export class AuthIntegrationEntity implements IAuthIntegration {
    private _uuid: string;
    private _status: boolean;
    private _authDetails?: any;
    private _organization?: Partial<IOrganization>;
    private _integration?: Partial<IIntegration>;

    constructor(authIntegration: IAuthIntegration | Partial<IAuthIntegration>) {
        this._uuid = authIntegration.uuid;
        this._status = authIntegration.status;
        this._authDetails = authIntegration.authDetails;
        this._organization = authIntegration.organization;
        this._integration = authIntegration.integration;
    }

    public static create(
        authIntegration: IAuthIntegration | Partial<IAuthIntegration>,
    ) {
        return new AuthIntegrationEntity(authIntegration);
    }

    public get uuid() {
        return this._uuid;
    }

    public get status() {
        return this._status;
    }

    public get authDetails() {
        return this._authDetails;
    }

    public get organization() {
        return this._organization;
    }

    public get integration() {
        return this._integration;
    }
}
