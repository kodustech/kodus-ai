import { FileChange } from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

export const PULL_REQUEST_MANAGER_SERVICE_TOKEN = Symbol(
    'PullRequestManagerService',
);

export interface IPullRequestManagerService {
    getPullRequestDetails(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        prNumber: number,
    ): Promise<any>;

    getChangedFiles(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        pullRequest: any,
        ignorePaths: string[],
        lastCommit?: string,
    ): Promise<FileChange[]>;

    getPullRequestsAuthorsOrderedByContributions(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any>;
}
