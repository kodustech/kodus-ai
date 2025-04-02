import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

export const CHECKIN_INSIGHTS_SERVICE_TOKEN = Symbol('CheckinInsightsService');

export interface ICheckinInsightsService {
    getInsightsForOffTrackItems(
        organizationAndTeamData: OrganizationAndTeamData,
        workItems: any,
        metrics: any,
        wipColumns: any,
    ): Promise<any>;
    getMetricsDataToInsights(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any>;
}
