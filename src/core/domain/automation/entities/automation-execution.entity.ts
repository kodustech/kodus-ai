import { AutomationStatus } from '../enums/automation-status';
import { IAutomationExecution } from '../interfaces/automation-execution.interface';
import { IAutomation } from '../interfaces/automation.interface';
import { ITeamAutomation } from '../interfaces/team-automation.interface';

export class AutomationExecutionEntity implements IAutomationExecution {
    private _uuid: string;
    private _createdAt: Date;
    private _updatedAt: Date;
    private _status: AutomationStatus;
    private _errorMessage?: string;
    private _dataExecution?: any;
    private _teamAutomation?: Partial<ITeamAutomation>;
    private _origin?: string;

    constructor(
        automationExecution:
            | IAutomationExecution
            | Partial<IAutomationExecution>,
    ) {
        this._uuid = automationExecution.uuid;
        this._createdAt = automationExecution.createdAt;
        this._updatedAt = automationExecution.updatedAt;
        this._status = automationExecution.status;
        this._errorMessage = automationExecution.errorMessage;
        this._dataExecution = automationExecution.dataExecution;
        this._teamAutomation = automationExecution.teamAutomation;
        this._origin = automationExecution.origin;
    }

    public static create(
        automationExecution:
            | IAutomationExecution
            | Partial<IAutomationExecution>,
    ): AutomationExecutionEntity {
        return new AutomationExecutionEntity(automationExecution);
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

    public get teamAutomation(): Partial<IAutomation> {
        return this._teamAutomation;
    }

    public get origin(): string {
        return this._origin;
    }
}
