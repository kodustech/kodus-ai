import { AutomationLevel } from '@/shared/domain/enums/automations-level.enum';
import { AutomationType } from '../enums/automation-type';
import { IAutomation } from '../interfaces/automation.interface';

export class AutomationEntity implements IAutomation {
    private _uuid: string;
    private _name: string;
    private _description: string;
    private _tags: string[];
    private _antiPatterns: string[];
    private _automationType: AutomationType;
    private _status: boolean;
    private _level: AutomationLevel;


    constructor(automation: IAutomation | Partial<IAutomation>) {
        this._uuid = automation.uuid;
        this._name = automation.name;
        this._description = automation.description;
        this._tags = automation.tags;
        this._antiPatterns = automation.antiPatterns;
        this._automationType = automation.automationType;
        this._status = automation.status;
        this._level = automation.level;
    }

    public static create(
        automation: IAutomation | Partial<IAutomation>,
    ): AutomationEntity {
        return new AutomationEntity(automation);
    }

    get uuid(): string {
        return this._uuid;
    }

    get name(): string {
        return this._name;
    }

    get description(): string {
        return this._description;
    }

    get tags(): string[] {
        return this._tags;
    }

    get antiPatterns(): string[] {
        return this._antiPatterns;
    }

    get automationType(): AutomationType {
        return this._automationType;
    }

    get status(): boolean {
        return this._status;
    }

    get level(): AutomationLevel {
        return this._level;
    }
}
