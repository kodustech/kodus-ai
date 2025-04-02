import { TeamAutomationEntity } from '../entities/team-automation.entity';
import { ITeamAutomation } from '../interfaces/team-automation.interface';
import { ITeamAutomationRepository } from './team-automation.repository';

export const TEAM_AUTOMATION_SERVICE_TOKEN = Symbol('TeamAutomationService');

export interface ITeamAutomationService extends ITeamAutomationRepository {
    register(
        teamAutomation: Omit<ITeamAutomation, 'uuid'>,
    ): Promise<TeamAutomationEntity>;
    hasActiveTeamAutomation(
        teamId: string,
        automation: string,
    ): Promise<boolean>;
}
