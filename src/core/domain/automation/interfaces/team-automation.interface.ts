import { ITeam } from '../../team/interfaces/team.interface';
import { IAutomation } from './automation.interface';

export interface ITeamAutomation {
    uuid?: string;
    status: boolean;
    automation?: Partial<IAutomation>;
    team?: Partial<ITeam>;
}
