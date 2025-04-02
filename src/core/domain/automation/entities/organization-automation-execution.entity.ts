import { AutomationStatus } from '../enums/automation-status';
import { IAutomation } from '../interfaces/automation.interface';
import { IOrganizationAutomationExecution } from '../interfaces/organization-automation-execution.interface';
import { IOrganizationAutomation } from '../interfaces/organization-automation.interface';

export class OrganizationAutomationExecutionEntity implements IOrganizationAutomationExecution {
    private _uuid: string;
    private _createdAt: Date;
    private _updatedAt: Date;
    private _status: AutomationStatus;
    private _errorMessage?: string;
    private _dataExecution?: any;
    private _organizationAutomation?: Partial<IOrganizationAutomation>;
    private _origin?: string;

    constructor(
        organizationAutomationExecution:
            | IOrganizationAutomationExecution
            | Partial<IOrganizationAutomationExecution>,
    ) {
        this._uuid = organizationAutomationExecution.uuid;
        this._createdAt = organizationAutomationExecution.createdAt;
        this._updatedAt = organizationAutomationExecution.updatedAt;
        this._status = organizationAutomationExecution.status;
        this._errorMessage = organizationAutomationExecution.errorMessage;
        this._dataExecution = organizationAutomationExecution.dataExecution;
        this._organizationAutomation = organizationAutomationExecution.organizationAutomation;
        this._origin = organizationAutomationExecution.origin;
    }

    public static create(
        organizationAutomationExecution:
            | IOrganizationAutomationExecution
            | Partial<IOrganizationAutomationExecution>,
    ): OrganizationAutomationExecutionEntity {
        return new OrganizationAutomationExecutionEntity(organizationAutomationExecution);
    }

    public get uuid(): string {
        return this._uuid;
    }

    public get createdAt(): Date {
        return this._createdAt;
    }

    public get updatedAt(): Date {
        return this._updatedAt;
    }

    public get status(): AutomationStatus {
        return this._status;
    }

    public get errorMessage(): string {
        return this._errorMessage;
    }

    public get dataExecution(): any {
        return this._dataExecution;
    }

    public get organizationAutomation(): Partial<IAutomation> {
        return this._organizationAutomation;
    }

    public get origin(): string {
        return this._origin;
    }
}
