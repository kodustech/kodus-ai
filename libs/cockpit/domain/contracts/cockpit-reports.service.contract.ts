import { OrgReportData, RepoReportSection } from '../report-types';

export const COCKPIT_REPORTS_SERVICE_TOKEN = Symbol.for(
    'CockpitReportsService',
);

/**
 * Contract for the report data assembly (org report + per-repo sections).
 * Consumers (the send use-cases) depend on this interface + token rather than
 * the concrete service, per the team's DI-decoupling rule.
 */
export interface ICockpitReportsService {
    buildOrgReport(
        organizationId: string,
        company: string,
        startDate: string,
        endDate: string,
    ): Promise<OrgReportData>;
    buildRepoSections(
        organizationId: string,
        repositories: string[],
        startDate: string,
        endDate: string,
    ): Promise<RepoReportSection[]>;
}
