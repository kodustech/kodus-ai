import { TeamAutomationEntity } from '../entities/team-automation.entity';
import { ITeamAutomation } from '../interfaces/team-automation.interface';

export const TEAM_AUTOMATION_REPOSITORY_TOKEN = Symbol(
    'TeamAutomationRepository',
);

export interface ITeamAutomationRepository {
    create(teamAutomation: ITeamAutomation): Promise<TeamAutomationEntity>;
    update(
        filter: Partial<ITeamAutomation>,
        data: Partial<ITeamAutomation>,
    ): Promise<TeamAutomationEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findById(uuid: string): Promise<TeamAutomationEntity | null>;
    find(filter?: Partial<ITeamAutomation>): Promise<TeamAutomationEntity[]>;
}
