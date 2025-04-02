import { ITeam } from '../../team/interfaces/team.interface';
import { IAutomation } from '../interfaces/automation.interface';
import { ITeamAutomation } from '../interfaces/team-automation.interface';

export class TeamAutomationEntity implements ITeamAutomation {
    private _uuid: string;
    private _status: boolean;
    private _automation?: Partial<IAutomation>;
    private _team?: Partial<ITeam>;

    constructor(teamAutomation: ITeamAutomation | Partial<ITeamAutomation>) {
        this._uuid = teamAutomation.uuid;
        this._status = teamAutomation.status;
        this._automation = teamAutomation.automation;
        this._team = teamAutomation.team;
    }

    public static create(
        teamAutomation: ITeamAutomation | Partial<ITeamAutomation>,
    ): TeamAutomationEntity {
        return new TeamAutomationEntity(teamAutomation);
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

    public get team(): Partial<ITeam> {
        return this._team;
    }
}
