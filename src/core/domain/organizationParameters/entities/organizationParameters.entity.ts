import { OrganizationParametersKey } from "@/shared/domain/enums/organization-parameters-key.enum";
import { IOrganizationParameters } from "../interfaces/organizationParameters.interface";
import { IOrganization } from "../../organization/interfaces/organization.interface";

export class OrganizationParametersEntity implements IOrganizationParameters {
    private _uuid: string;
    private _configKey: OrganizationParametersKey;
    private _configValue: any;
    private _organization?: Partial<IOrganization>;

    constructor(organizationParameters: IOrganizationParameters | Partial<IOrganizationParameters>) {
        this._uuid = organizationParameters.uuid;
        this._configKey = organizationParameters.configKey;
        this._configValue = organizationParameters.configValue;
        this._organization = organizationParameters.organization;
    }

    public static create(parameters: IOrganizationParameters | Partial<IOrganizationParameters>) {
        return new OrganizationParametersEntity(parameters);
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

    public get organization() {
        return this._organization;
    }
}
