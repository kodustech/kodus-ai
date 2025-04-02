import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { InstallationStatus } from '@/shared/domain/enums/github-installation-status.enum';

export const GITHUB_SERVICE_TOKEN = Symbol('GithubService');

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
    getAllMembersByOrg(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any>;
    getListPullRequests(
        organizationAndTeamData: OrganizationAndTeamData,
        filters?: any,
    ): Promise<any>;
}
