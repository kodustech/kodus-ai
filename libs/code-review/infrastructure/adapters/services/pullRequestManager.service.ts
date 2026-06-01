import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import pLimit from 'p-limit';

import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Commit } from '@libs/core/infrastructure/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IPullRequestManagerService } from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { CacheService } from '@libs/core/cache/cache.service';
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import { PullRequestAuthor } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';

@Injectable()
export class PullRequestHandlerService implements IPullRequestManagerService {
    private readonly logger = createLogger(PullRequestHandlerService.name);

    /**
     * Limite de concorrência para requisições de conteúdo de arquivos.
     *
     * Foi reduzido de 100 para 30 após incidente em que uma única
     * instalação saturou o bucket horário da GitHub App (5k-15k req/h)
     * e bloqueou code-review + webhook por ~1h em todos os jobs daquela
     * org. Com prefetch=20 por worker e 15 workers, 30 já permite até
     * 9000 chamadas simultâneas no cluster — qualquer valor maior só
     * acelera a saturação sem ganho proporcional de throughput.
     */
    private readonly FILE_CONTENT_CONCURRENCY = 30;

    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly cacheService: CacheService,
    ) {}

    async getPullRequestDetails(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        prNumber: number,
    ): Promise<any> {
        try {
            return await this.codeManagementService.getPullRequest({
                organizationAndTeamData,
                repository,
                prNumber,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error fetching pull request details',
                context: PullRequestHandlerService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    repository,
                    prNumber,
                },
            });
            throw error;
        }
    }

    async getChangedFiles(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        pullRequest: any,
        ignorePaths?: string[],
        lastCommit?: string,
    ): Promise<FileChange[]> {
        try {
            let changedFiles: FileChange[];

            if (lastCommit) {
                // Retrieve files changed since the last commit
                changedFiles =
                    await this.codeManagementService.getChangedFilesSinceLastCommit(
                        {
                            organizationAndTeamData,
                            repository,
                            prNumber: pullRequest?.number,
                            lastCommit,
                        },
                    );
            } else {
                // Retrieve all files changed in the pull request. Pass
                // `headSha` so the GitHub adapter can memoize by (PR, SHA)
                // — `getChangedFilesMetadata` will hit the same key in the
                // same job, halving the GitHub fan-out.
                changedFiles =
                    await this.codeManagementService.getFilesByPullRequestId({
                        organizationAndTeamData,
                        repository,
                        prNumber: pullRequest?.number,
                        headSha: pullRequest?.head?.sha,
                    });
            }

            // Filter files based on ignorePaths and retrieve their content.
            // Also skip `removed` files: they don't exist in the head ref,
            // so `getRepositoryContentFile` would 404 + fall back to base
            // ref — wasting two GitHub requests for content we'll never
            // review. Real impact: ~10-20% of /contents calls on PRs with
            // file deletions.
            const filteredFiles = changedFiles?.filter((file) => {
                if (file.status === 'removed') return false;
                return !isFileMatchingGlob(file.filename, ignorePaths);
            });

            if (!filteredFiles?.length) {
                this.logger.warn({
                    message: `No files to review after filtering PR#${pullRequest?.number}`,
                    context: PullRequestHandlerService.name,
                    metadata: {
                        repository,
                        prNumber: pullRequest?.number,
                        ignorePaths,
                        changedFilePaths:
                            changedFiles?.map((file) => file.filename) || [],
                    },
                });
            }

            // Retrieve the content of the filtered files with concurrency limit
            if (filteredFiles && filteredFiles.length > 0) {
                const limit = pLimit(this.FILE_CONTENT_CONCURRENCY);

                const filesWithContent = await Promise.all(
                    filteredFiles.map((file) =>
                        limit(async () => {
                            try {
                                const fileContent =
                                    await this.codeManagementService.getRepositoryContentFile(
                                        {
                                            organizationAndTeamData,
                                            repository,
                                            file,
                                            pullRequest,
                                        },
                                    );

                                // If the content exists and is in base64, decode it
                                const content = fileContent?.data?.content;
                                let decodedContent = content;

                                if (
                                    content &&
                                    fileContent?.data?.encoding === 'base64'
                                ) {
                                    decodedContent = Buffer.from(
                                        content,
                                        'base64',
                                    ).toString('utf-8');
                                }

                                return {
                                    ...file,
                                    fileContent: decodedContent,
                                };
                            } catch (error) {
                                this.logger.error({
                                    message: `Error fetching content for file: ${file.filename}`,
                                    context: PullRequestHandlerService.name,
                                    error,
                                    metadata: {
                                        organizationAndTeamData,
                                        repository,
                                        prNumber: pullRequest?.number,
                                        filename: file.filename,
                                    },
                                });
                                return file;
                            }
                        }),
                    ),
                );

                return filesWithContent;
            }

            return filteredFiles || [];
        } catch (error) {
            this.logger.error({
                message: 'Error fetching changed files',
                context: PullRequestHandlerService.name,
                error,
                metadata: { ...pullRequest, repository },
            });
            throw error;
        }
    }

    async getPullRequestAuthorsWithCache(
        organizationAndTeamData: OrganizationAndTeamData,
        determineBots?: boolean,
    ): Promise<PullRequestAuthor[]> {
        const baseKey = organizationAndTeamData.teamId
            ? `pr_authors_60d_${organizationAndTeamData.organizationId}_${organizationAndTeamData.teamId}`
            : `pr_authors_60d_${organizationAndTeamData.organizationId}`;
        const cacheKey = determineBots ? `${baseKey}_bots` : baseKey;
        const TTL = 10 * 60 * 1000; // 10 minutos

        try {
            const cachedAuthors =
                await this.cacheService.getFromCache<PullRequestAuthor[]>(
                    cacheKey,
                );

            if (cachedAuthors?.length > 0) {
                return cachedAuthors;
            }

            const authors =
                await this.codeManagementService.getPullRequestAuthors({
                    organizationAndTeamData,
                    determineBots,
                });

            await this.cacheService.addToCache(cacheKey, authors, TTL);

            return authors;
        } catch (error) {
            this.logger.error({
                message: 'Error fetching pull request authors',
                context: PullRequestHandlerService.name,
                error,
                metadata: { organizationAndTeamData },
            });
            throw error;
        }
    }

    async getNewCommitsSinceLastExecution(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        pullRequest: any,
        lastCommit?: any,
    ): Promise<Commit[]> {
        try {
            const commits =
                (await this.codeManagementService.getCommitsForPullRequestForCodeReview(
                    {
                        organizationAndTeamData,
                        repository,
                        prNumber: pullRequest?.number,
                        // Memoize by (PR, SHA) — CommentManagerService hits
                        // the same call during comment threading, so this
                        // dedups the second fetch in the same pipeline.
                        headSha: pullRequest?.head?.sha,
                    },
                )) as Commit[];

            if (!commits || commits.length === 0) {
                this.logger.warn({
                    message: `No commits found for PR#${pullRequest?.number}`,
                    context: PullRequestHandlerService.name,
                    metadata: {
                        organizationAndTeamData,
                        repository,
                        pullRequestNumber: pullRequest?.number,
                    },
                });
                return [];
            }

            if (lastCommit && lastCommit.sha) {
                const lastCommitIndex = commits.findIndex(
                    (commit) => commit.sha === lastCommit.sha,
                );

                if (lastCommitIndex !== -1) {
                    return commits.slice(lastCommitIndex + 1);
                }
            }

            return commits;
        } catch (error) {
            this.logger.error({
                message: 'Error fetching new commits since last execution',
                context: PullRequestHandlerService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    repository,
                    pullRequestNumber: pullRequest?.number,
                    lastCommit,
                },
            });

            throw error;
        }
    }

    /**
     * Busca apenas metadados dos arquivos alterados (sem conteúdo).
     * Mais rápido que getChangedFiles pois não faz chamadas repos.getContent.
     */
    async getChangedFilesMetadata(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        pullRequest: any,
        lastCommit?: string,
    ): Promise<FileChange[]> {
        try {
            let changedFiles: FileChange[];

            if (lastCommit) {
                changedFiles =
                    await this.codeManagementService.getChangedFilesSinceLastCommit(
                        {
                            organizationAndTeamData,
                            repository,
                            prNumber: pullRequest?.number,
                            lastCommit,
                        },
                    );
            } else {
                changedFiles =
                    await this.codeManagementService.getFilesByPullRequestId({
                        organizationAndTeamData,
                        repository,
                        prNumber: pullRequest?.number,
                        // Memoization key (see GithubService.getFilesByPullRequestId).
                        // The same call lands in `getChangedFiles` earlier in
                        // the pipeline; same (PR, SHA) → cache hit, no extra
                        // GitHub round-trip on this second hop.
                        headSha: pullRequest?.head?.sha,
                    });
            }

            return changedFiles || [];
        } catch (error) {
            this.logger.error({
                message: 'Error fetching changed files metadata',
                context: PullRequestHandlerService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber: pullRequest?.number,
                    repository,
                },
            });
            throw error;
        }
    }

    /**
     * Enriquece arquivos com conteúdo.
     * Usado para buscar conteúdo apenas dos arquivos que passaram pelo filtro ignorePaths.
     *
     * GitHub: 1 GraphQL request por batch de 50 arquivos (custa 1 ponto no
     * bucket graphql), vs N REST `repos.getContent` (1 ponto cada no
     * bucket core). Cai pra REST per-file quando a plataforma não suporta
     * batch ou quando o batch falha. Demais plataformas: REST per-file
     * com pLimit (comportamento original preservado).
     */
    async enrichFilesWithContent(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        pullRequest: any,
        files: FileChange[],
    ): Promise<FileChange[]> {
        if (!files || files.length === 0) {
            return [];
        }

        const decode = (fc: any) => {
            const content = fc?.data?.content;
            if (
                typeof content === 'string' &&
                fc?.data?.encoding === 'base64'
            ) {
                return Buffer.from(content, 'base64').toString('utf-8');
            }
            return content;
        };

        try {
            // Batch path. The platform adapter returns null when it
            // doesn't support batch (GitLab/Bitbucket/Azure/Forgejo
            // today) — falls through to the per-file path below.
            // Wrapped in its own try/catch so a throw from the batch
            // method (e.g., GraphQL client setup failure, expired
            // installation token) degrades gracefully to per-file REST
            // instead of aborting the whole stage.
            let batchMap: Map<string, any> | null | undefined;
            try {
                batchMap =
                    await this.codeManagementService.getRepositoryContentBatch(
                        {
                            organizationAndTeamData,
                            repository,
                            files,
                            pullRequest,
                        },
                    );
            } catch (batchErr) {
                this.logger.warn({
                    message:
                        'getRepositoryContentBatch threw — falling back to REST per-file',
                    context: PullRequestHandlerService.name,
                    error: batchErr,
                    metadata: {
                        organizationAndTeamData,
                        prNumber: pullRequest?.number,
                        repositoryName: repository?.name,
                        fileCount: files.length,
                    },
                });
                batchMap = null;
            }

            if (batchMap) {
                return files.map((file) => {
                    const fc = batchMap.get(file.filename);
                    if (!fc) {
                        this.logger.warn({
                            message: `Batch returned no content for file: ${file.filename}`,
                            context: PullRequestHandlerService.name,
                            metadata: {
                                organizationAndTeamData,
                                prNumber: pullRequest?.number,
                                filename: file.filename,
                            },
                        });
                        return file;
                    }
                    return { ...file, fileContent: decode(fc) };
                });
            }

            // REST per-file fallback (GitLab/Bitbucket/Azure or batch
            // returned null). pLimit caps concurrency to keep secondary
            // rate-limit and connection pressure in check.
            const limit = pLimit(this.FILE_CONTENT_CONCURRENCY);
            const filesWithContent = await Promise.all(
                files.map((file) =>
                    limit(async () => {
                        try {
                            const fileContent =
                                await this.codeManagementService.getRepositoryContentFile(
                                    {
                                        organizationAndTeamData,
                                        repository,
                                        file,
                                        pullRequest,
                                    },
                                );

                            return {
                                ...file,
                                fileContent: decode(fileContent),
                            };
                        } catch (error) {
                            this.logger.error({
                                message: `Error fetching content for file: ${file.filename}`,
                                context: PullRequestHandlerService.name,
                                error,
                                metadata: {
                                    organizationAndTeamData,
                                    prNumber: pullRequest?.number,
                                    repository,
                                    filename: file.filename,
                                },
                            });
                            return file;
                        }
                    }),
                ),
            );

            return filesWithContent;
        } catch (error) {
            this.logger.error({
                message: 'Error enriching files with content',
                context: PullRequestHandlerService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber: pullRequest?.number,
                    repository,
                    fileCount: files.length,
                },
            });
            throw error;
        }
    }
}
