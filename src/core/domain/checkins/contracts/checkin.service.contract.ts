import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { CheckinConfigValue } from '../../parameters/types/configValue.type';
import { ITeam } from '../../team/interfaces/team.interface';

export const CHECKIN_SERVICE_TOKEN = Symbol('CheckinService');

export interface ICheckinService {
    generate(payload: {
        organizationAndTeamData: OrganizationAndTeamData;
        checkinConfig: CheckinConfigValue;
        team: Partial<ITeam>;
    }): Promise<any>;

    getSectionsInfo(): { name: string; id: string }[];
}
