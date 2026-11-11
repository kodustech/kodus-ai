import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Commit } from '@libs/core/infrastructure/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import type { RebaseInterdiffResult } from '@libs/code-review/infrastructure/adapters/services/rebase-interdiff';
import { PullRequestAuthor } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';

export const PULL_REQUEST_MANAGER_SERVICE_TOKEN = Symbol(
    'PullRequestManagerService',
);

/**
 * Which diff `getChangedFiles` returned: the changes since the reviewed commit
 * (`incremental`), the PR's changes since then rebuilt after a rebase
 * (`interdiff`), the whole PR because neither could be read (`full`), or the
 * whole PR because there was no reviewed commit to start from (`none`).
 */
export type ChangedFilesSource = 'incremental' | 'interdiff' | 'full' | 'none';

export type ChangedFilesOptions = {
    onDiffSource?: (source: ChangedFilesSource) => void;
};

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
        reviewedBaseBranch?: string,
        options?: ChangedFilesOptions,
    ): Promise<FileChange[]>;

    /**
     * Busca apenas metadados dos arquivos alterados (sem conteúdo).
     * Mais rápido que getChangedFiles pois não faz chamadas repos.getContent.
     */
    getChangedFilesMetadata(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any; project?: { id: any } },
        pullRequest: any,
        lastCommit?: string,
        /** Base branch of the last review; a retargeted PR is read whole. */
        reviewedBaseBranch?: string,
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

    /**
     * After a rebase: the current PR files with only the hunks that were not
     * in the PR diff at `previousHeadSha`. Null when that diff can't be read.
     */
    getRebaseInterdiff(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any; project?: { id: any } },
        pullRequest: any,
        previousHeadSha: string,
    ): Promise<
        | (RebaseInterdiffResult & {
              /** The current PR diff the interdiff was read from. */
              currentFiles: FileChange[];
          })
        | null
    >;

    getNewCommitsSinceLastExecution(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        pullRequest: any,
        lastCommit?: string,
    ): Promise<Commit[]>;
}
