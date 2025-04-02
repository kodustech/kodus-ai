import { Injectable } from '@nestjs/common';
import { FileChange } from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { CodeManagementService } from '../platformIntegration/codeManagement.service';
import { PinoLoggerService } from '../logger/pino.service';
import { IPullRequestManagerService } from '../../../../domain/codeBase/contracts/PullRequestManagerService.contract';
import { isFileMatchingGlob } from '@/shared/utils/glob-utils';
import { AuthorContribution } from '@/core/domain/pullRequests/interfaces/authorContributor.interface';

@Injectable()
export class PullRequestHandlerService implements IPullRequestManagerService {
    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly logger: PinoLoggerService,
    ) {}

    async getPullRequestDetails(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        prNumber: number,
    ): Promise<any> {
        // Existing implementation or add necessary implementation
    }

    async getChangedFiles(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        pullRequest: any,
        ignorePaths: string[],
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
                // Retrieve all files changed in the pull request
                changedFiles =
                    await this.codeManagementService.getFilesByPullRequestId({
                        organizationAndTeamData,
                        repository,
                        prNumber: pullRequest?.number,
                    });
            }

            // Filter files based on ignorePaths and retrieve their content
            const filteredFiles = changedFiles?.filter((file) => {
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

            // Retrieve the content of the filtered files
            if (filteredFiles && filteredFiles.length > 0) {
                const filesWithContent = await Promise.all(
                    filteredFiles.map(async (file) => {
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
                                    ...pullRequest,
                                    repository,
                                    filename: file.filename,
                                },
                            });
                            return file;
                        }
                    }),
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

    async getPullRequestsAuthorsOrderedByContributions(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<AuthorContribution[]> {
        try {
            const startDate = new Date();
            const endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() - 60);

            const pullRequests =
                await this.codeManagementService.getPullRequests({
                    organizationAndTeamData,
                    filters: {
                        startDate: endDate.toISOString(), // Reversing the dates to fetch the last 15 days
                        endDate: startDate.toISOString(),
                    },
                });

            // Group the PRs by author and count the contributions
            const authorContributions = pullRequests.reduce<
                Record<string, AuthorContribution>
            >((acc, pr) => {
                const authorId = pr.author_id;
                const authorName = pr.author_name;

                if (!authorId) {
                    this.logger.warn({
                        message: 'Skipping PR with missing author ID',
                        context: PullRequestHandlerService.name,
                        metadata: { pr },
                    });
                    return acc;
                }

                if (!acc[authorId]) {
                    acc[authorId] = {
                        id: authorId,
                        name: authorName,
                        contributions: 0,
                    };
                }

                acc[authorId].contributions++;
                return acc;
            }, {});

            // Convert to array and sort by number of contributions
            const sortedAuthors = Object.values<AuthorContribution>(
                authorContributions,
            ).sort((a, b) => b.contributions - a.contributions);

            return sortedAuthors;
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
}
