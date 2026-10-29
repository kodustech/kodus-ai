import { InstallationStatus } from '@libs/core/domain/enums/github-installation-status.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export const GITHUB_SERVICE_TOKEN = Symbol.for('GithubService');

export interface IGithubService {
    accessToken(
        code: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string | { isUserToken?: boolean }>;
    updateInstallationItems(
        body: {
            installId?: string;
            installationStatus?: InstallationStatus;
            organizationName?: string;
        },
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any>;
    findOneByOrganizationId(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any>;
    findOneByOrganizationName(organizationName: string): Promise<any>;
    findOneByInstallId(installId: string): Promise<any>;
    getInstallationAuthorizationUrl(params: {
        installationId: unknown;
        userId: string;
        organizationId: string;
    }): { url: string };
    getAllMembersByOrg(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any>;
    getListPullRequests(
        organizationAndTeamData: OrganizationAndTeamData,
        filters?: any,
    ): Promise<any>;
}
