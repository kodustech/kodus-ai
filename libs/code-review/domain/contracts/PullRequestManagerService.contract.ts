import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Commit } from '@libs/core/infrastructure/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PullRequestAuthor } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';

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
        repository: { name: string; id: any; project?: { id: any } },
        pullRequest: any,
        ignorePaths: string[],
        lastCommit?: string,
    ): Promise<FileChange[]>;

    /**
     * Busca apenas metadados dos arquivos alterados (sem conteúdo).
     * Mais rápido que getChangedFiles pois não faz chamadas repos.getContent.
     */
    getChangedFilesMetadata(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any; project?: { id: any } },
        pullRequest: any,
        lastCommit?: string | { sha?: string },
    ): Promise<FileChange[]>;

    /**
     * Enriquece arquivos com conteúdo.
     * Usado para buscar conteúdo apenas dos arquivos que passaram pelo filtro ignorePaths.
     */
    enrichFilesWithContent(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any; project?: { id: any } },
        pullRequest: any,
        files: FileChange[],
    ): Promise<FileChange[]>;

    getPullRequestAuthorsWithCache(
        organizationAndTeamData: OrganizationAndTeamData,
        determineBots?: boolean,
    ): Promise<PullRequestAuthor[]>;

    getNewCommitsSinceLastExecution(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        pullRequest: any,
        lastCommit?: string,
    ): Promise<Commit[]>;
}
