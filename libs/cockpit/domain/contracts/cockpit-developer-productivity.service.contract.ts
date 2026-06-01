import {
    CockpitRangeQuery,
    CompanyDashboard,
    DeployFrequencyHighlight,
    DeployFrequencyRow,
    DeveloperActivityRow,
    LeadTimeBreakdownRow,
    LeadTimeHighlight,
    LeadTimeRow,
    PRSizeHighlight,
    PullRequestSizeRow,
    PullRequestsByDevRow,
    PullRequestsOpenedVsClosedRow,
} from '../types';

export const COCKPIT_DEVELOPER_PRODUCTIVITY_SERVICE_TOKEN = Symbol(
    'CockpitDeveloperProductivityService',
);

export interface ICockpitDeveloperProductivityService {
    getDeployFrequencyChart(q: CockpitRangeQuery): Promise<DeployFrequencyRow[]>;
    getDeployFrequencyHighlight(
        q: CockpitRangeQuery,
    ): Promise<DeployFrequencyHighlight>;
    getLeadTimeChart(q: CockpitRangeQuery): Promise<LeadTimeRow[]>;
    getLeadTimeHighlight(q: CockpitRangeQuery): Promise<LeadTimeHighlight>;
    getPullRequestsByDev(
        q: CockpitRangeQuery,
    ): Promise<PullRequestsByDevRow[]>;
    getPullRequestSizeHighlight(q: CockpitRangeQuery): Promise<PRSizeHighlight>;
    getPullRequestSizeChart(
        q: CockpitRangeQuery,
    ): Promise<PullRequestSizeRow[]>;
    getLeadTimeBreakdown(
        q: CockpitRangeQuery,
    ): Promise<LeadTimeBreakdownRow[]>;
    getPullRequestsOpenedVsClosed(
        q: CockpitRangeQuery,
    ): Promise<PullRequestsOpenedVsClosedRow[]>;
    getDeveloperActivity(
        q: CockpitRangeQuery,
    ): Promise<DeveloperActivityRow[]>;
    getCompanyDashboard(q: CockpitRangeQuery): Promise<CompanyDashboard>;
    getCompanyDashboardInsights(
        q: CockpitRangeQuery,
    ): Promise<CompanyDashboard>;
}
