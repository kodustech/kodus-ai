import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';

export interface GetPullRequestFilesParams {
    organizationId: string;
    teamId: string;
    repositoryId: string;
    repositoryName?: string;
    prNumber: number;
}

export interface PullRequestFileDto {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
    previous_filename?: string;
}

export interface PullRequestCommitDto {
    sha: string;
    message: string;
    authorLogin?: string;
    authoredAt?: string;
    htmlUrl: string;
}

export interface GetPullRequestFilesResult {
    files: PullRequestFileDto[];
    commits: PullRequestCommitDto[];
}

/**
 * Returns a PR's changed files (with unified-diff patches) + commit metadata
 * for the review screen. Tries the Git provider first and falls back to the
 * `pullRequests` snapshot captured at review time, so the screen still renders
 * when the provider is unreachable (and for cloned/historical PRs).
 *
 * Lives in the application layer (not the controller) because it orchestrates
 * multiple services, recovers from provider errors and shapes the result.
 */
@Injectable()
export class GetPullRequestFilesUseCase {
    constructor(
        private readonly codeManagementService: CodeManagementService,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,
    ) {}

    async execute(
        params: GetPullRequestFilesParams,
    ): Promise<GetPullRequestFilesResult> {
        const { organizationId, teamId, repositoryId, prNumber } = params;
        const organizationAndTeamData = { organizationId, teamId };

        const repoName = await this.resolveRepoName(
            params.repositoryName,
            repositoryId,
            organizationAndTeamData,
        );

        let providerFiles: any[];
        try {
            providerFiles =
                await this.codeManagementService.getFilesByPullRequestId({
                    organizationAndTeamData,
                    repository: { name: repoName, id: repositoryId },
                    prNumber,
                });
        } catch {
            // Provider call failed (rate limit, revoked token, repo the
            // integration can't reach). Fall through to the stored snapshot.
            providerFiles = [];
        }

        // Always read the stored snapshot — it's the source of commit metadata
        // (the provider files call doesn't carry it) and the fallback for the
        // diff when the provider is unreachable.
        const stored =
            await this.pullRequestsService.findByNumberAndRepositoryId(
                prNumber,
                repositoryId,
                organizationAndTeamData,
            );

        const commits = mapStoredCommits(stored);

        if (providerFiles && providerFiles.length > 0) {
            return {
                files: providerFiles.map((f: any) => ({
                    filename: f.filename,
                    status: f.status,
                    additions: f.additions,
                    deletions: f.deletions,
                    changes: f.changes,
                    patch: f.patch,
                    previous_filename: f.previous_filename,
                })),
                commits,
            };
        }

        return {
            files: (stored?.files || [])
                .filter((f: any) => f?.patch)
                .map((f: any) => ({
                    filename: f.path ?? f.filename,
                    status: f.status,
                    // Coalesce both payload shapes: the snapshot uses
                    // added/deleted/previousName, the provider uses
                    // additions/deletions/previous_filename. Dropping either
                    // breaks stats + rename detection on cloned/unreachable PRs.
                    additions: f.added ?? f.additions,
                    deletions: f.deleted ?? f.deletions,
                    changes: f.changes,
                    patch: f.patch,
                    previous_filename: f.previousName ?? f.previous_filename,
                })),
            commits,
        };
    }

    private async resolveRepoName(
        repositoryName: string | undefined,
        repositoryId: string,
        organizationAndTeamData: { organizationId: string; teamId: string },
    ): Promise<string> {
        if (repositoryName) {
            return repositoryName;
        }

        const repositories = await this.codeManagementService.getRepositories({
            organizationAndTeamData,
        });
        const repo = (repositories || []).find(
            (r: any) => r?.id === repositoryId,
        );
        if (!repo) {
            throw new NotFoundException(
                `Repository not found (id: ${repositoryId})`,
            );
        }
        return repo.name;
    }
}

/**
 * Maps the commit metadata captured in the `pullRequests` snapshot into the
 * shape the review screen's Commits tab consumes. The provider files call
 * doesn't carry commits, so this is the only source for cloned/historical PRs.
 * The commit HTML url is derived from the stored PR url (strip the PR/MR
 * suffix, append `/commit/<sha>`) since the snapshot doesn't store it.
 */
function mapStoredCommits(stored: any): PullRequestCommitDto[] {
    const prUrl: string = stored?.url ?? '';
    const base = prUrl.includes('/pull/')
        ? prUrl.split('/pull/')[0]
        : prUrl.includes('/-/merge_requests/')
          ? prUrl.split('/-/merge_requests/')[0]
          : prUrl.includes('/pullrequest/')
            ? prUrl.split('/pullrequest/')[0]
            : '';

    return (stored?.commits || []).map((c: any) => {
        const sha: string = c?.sha ?? '';
        const author = c?.author ?? {};
        return {
            sha,
            message: String(c?.message ?? '').split('\n')[0],
            authorLogin: author.username || author.name || undefined,
            authoredAt: author.date || c?.created_at || undefined,
            htmlUrl: base && sha ? `${base}/commit/${sha}` : prUrl,
        };
    });
}
