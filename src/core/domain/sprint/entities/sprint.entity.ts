import { ITeam } from '../../team/interfaces/team.interface';
import { COMPILE_STATE } from '../enum/compileState.enum';
import { SPRINT_STATE } from '../enum/sprintState.enum';
import { ISprint } from '../interface/sprint.interface';

export class SprintEntity implements ISprint {
    private _uuid?: string;
    private _name: string;
    private _state: SPRINT_STATE;
    private _compileState: COMPILE_STATE;
    private _startDate?: Date;
    private _endDate?: Date;
    private _completeDate?: Date;
    private _description?: string;
    private _goal?: string;
    private _team?: Partial<ITeam>;
    private _value: any;
    private _projectManagementSprintId: string;

    constructor(sprint: ISprint | Partial<ISprint>) {
        this._uuid = sprint.uuid;
        this._name = sprint.name;
        this._state = sprint.state;
        this._startDate = sprint.startDate;
        this._endDate = sprint.endDate;
        this._completeDate = sprint.completeDate;
        this._description = sprint.description;
        this._goal = sprint.goal;
        this._team = sprint.team;
        this._value = sprint.value;
        this._projectManagementSprintId = sprint.projectManagementSprintId;
        this._compileState = sprint.compileState;
    }

    public static create(sprint: ISprint | Partial<ISprint>) {
        return new SprintEntity(sprint);
    }

    public get uuid() {
        return this._uuid;
    }

    public get name() {
        return this._name;
    }

    public get state() {
        return this._state;
    }

    public get startDate() {
        return this._startDate;
    }

    public get endDate() {
        return this._endDate;
    }

    public get completeDate() {
        return this._completeDate;
    }

    public get description() {
        return this._description;
    }

    public get goal() {
        return this._goal;
    }

    public get team() {
        return this._team;
    }

    public get value() {
        return this._value;
    }

    public get projectManagementSprintId() {
        return this._projectManagementSprintId;
    }

    public get compileState() {
        return this._compileState;
    }
}
