import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { ISprintRepository } from './sprint.repository.contracts';
import { ISprint } from '../interface/sprint.interface';

export const SPRINT_SERVICE_TOKEN = Symbol('SprintService');

export interface ISprintService extends ISprintRepository {
    getCurrentAndPreviousSprintForRetro(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{ currentSprint: ISprint; previousSprint: ISprint }>;
    compileLastSprint(organizationAndTeamData: OrganizationAndTeamData);
}
