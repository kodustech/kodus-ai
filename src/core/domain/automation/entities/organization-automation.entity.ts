import { IOrganization } from "../../organization/interfaces/organization.interface";
import { IAutomation } from "../interfaces/automation.interface";
import { IOrganizationAutomation } from "../interfaces/organization-automation.interface";

export class OrganizationAutomationEntity implements IOrganizationAutomation {
    private _uuid: string;
    private _status: boolean;
    private _automation?: Partial<IAutomation>;
    private _organization?: Partial<IOrganization>;

    constructor(organizationAutomation: IOrganizationAutomation | Partial<IOrganizationAutomation>) {
        this._uuid = organizationAutomation.uuid;
        this._status = organizationAutomation.status;
        this._automation = organizationAutomation.automation;
        this._organization = organizationAutomation.organization;
    }

    public static create(
        organizationAutomation: IOrganizationAutomation | Partial<IOrganizationAutomation>,
    ): OrganizationAutomationEntity {
        return new OrganizationAutomationEntity(organizationAutomation);
    }

    public get uuid(): string {
        return this._uuid;
    }

    public get status(): boolean {
        return this._status;
    }

    public get automation(): Partial<IAutomation> {
        return this._automation;
    }

    public get organization(): Partial<IOrganization> {
        return this._organization;
    }
}
