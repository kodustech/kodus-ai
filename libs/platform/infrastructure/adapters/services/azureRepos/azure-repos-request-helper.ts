import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

import { fitPRDescription } from '@libs/code-review/utils/fit-pr-description';
import { decrypt } from '@libs/common/utils/crypto';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { INTEGRATION_REQUEST_TIMEOUT_MS } from '@libs/core/infrastructure/http/integration-timeouts';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    AzureRepoChange,
    AzureRepoCommentType,
    AzureRepoCommit,
    AzureRepoFileContent,
    AzureRepoFileItem,
    AzureRepoIteration,
    AzureRepoPRThread,
    AzureRepoReviewerWithVote,
    AzureRepoSubscription,
} from '@libs/platform/domain/azure/entities/azureRepoExtras.type';
import {
    AzurePRStatus,
    AzureRepoPullRequest,
} from '@libs/platform/domain/azure/entities/azureRepoPullRequest.type';
import { AzureReposProject } from '@libs/platform/domain/azure/entities/azureReposProject.type';
import { AzureReposRepository } from '@libs/platform/domain/azure/entities/azureReposRepository.type';

@Injectable()
export class AzureReposRequestHelper {
    constructor() {}

    async getProjects(params: {
        orgName: string;
        token: string;
    }): Promise<AzureReposProject[]> {
        const instance = await this.azureRequest(params);
        const { data } = await instance.get('/_apis/projects?api-version=7.1');

        return data?.value;
    }

    /**
     * Obtém um projeto específico pelo seu ID
     */
    async getProject(params: {
        orgName: string;
        token: string;
        projectId: string;
    }): Promise<AzureReposProject> {
        const instance = await this.azureRequest(params);
        const { data } = await instance.get(
            `/_apis/projects/${params.projectId}?api-version=7.1`,
        );
        return data;
    }

    async getRepositories(params: {
        orgName: string;
        token: string;
        projectId: string;
    }): Promise<AzureReposRepository[]> {
        const instance = await this.azureRequest(params);
        const { data } = await instance.get(
            `/${params.projectId}/_apis/git/repositories?api-version=7.1`,
        );

        return data?.value;
    }

    async getPullRequestDetails(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prId: number | string;
    }): Promise<AzureRepoPullRequest> {
        const instance = await this.azureRequest(params);
        const { data } = await instance.get(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullrequests/${params.prId}?api-version=7.1`,
        );
        return data;
    }

    async getPullRequestsByRepo(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        filters?: {
            status?: AzurePRStatus;
            author?: string;
            branch?: string;
            minTime?: string;
            maxTime?: string;
        };
    }): Promise<AzureRepoPullRequest[]> {
        const {
            orgName,
            token,
            projectId,
            repositoryId,
            filters = {},
        } = params;

        const instance = await this.azureRequest({ orgName, token });

        const apiPath = `/${projectId}/_apis/git/repositories/${repositoryId}/pullrequests`;

        let queryParams: Record<string, string> = {
            'api-version': '7.1',
        };

        if (filters) {
            const searchCriteria = {
                status: filters.status,
                creatorId: filters.author,
                sourceRefName: filters.branch,
                minTime: filters.minTime,
                maxTime: filters.maxTime,
            };

            const dynamicParams = this._buildQueryParams(
                searchCriteria,
                'searchCriteria',
            );
            queryParams = { ...queryParams, ...dynamicParams };
        }

        const { data } = await instance.get(apiPath, { params: queryParams });

        return data?.value ?? [];
    }

    async getPullRequestComments(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prId: number | string;
    }): Promise<AzureRepoPRThread[]> {
        const instance = await this.azureRequest(params);
        const { data } = await instance.get(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullRequests/${params.prId}/threads?api-version=7.1`,
        );
        return data?.value ?? [];
    }

    async createReviewComment(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prId: number | string;
        filePath: string;
        start_line: number;
        line: number;
        commentContent: string;
    }): Promise<AzureRepoPRThread> {
        const instance = await this.azureRequest(params);

        const isMultiLine =
            params.start_line !== undefined && params.start_line !== null;

        const payload = {
            comments: [
                {
                    content: params.commentContent,
                    commentType: AzureRepoCommentType.CODE,
                },
            ],
            status: 'active',
            threadContext: {
                filePath: params.filePath,
                rightFileStart: {
                    line: Math.max(
                        isMultiLine ? params.start_line! : params.line,
                        1,
                    ),
                    offset: 1,
                },
                rightFileEnd: {
                    line: Math.max(params.line, 1),
                    offset: 1,
                },
            },
        };

        const { data } = await instance.post(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullRequests/${params.prId}/threads?api-version=7.1`,
            payload,
        );
        return data;
    }

    async createGeneralThread(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prId: number | string;
        comment: string;
    }): Promise<any> {
        const instance = await this.azureRequest(params);

        const payload = {
            comments: [
                {
                    content: params.comment,
                    commentType: AzureRepoCommentType.TEXT,
                },
            ],
            status: 'active',
        };

        const { data } = await instance.post(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullRequests/${params.prId}/threads?api-version=7.1`,
            payload,
        );
        return data;
    }

    async getDefaultBranch(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
    }): Promise<string> {
        const instance = await this.azureRequest(params);
        const { data } = await instance.get(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}?api-version=7.1`,
        );
        return data?.defaultBranch ?? '';
    }

    /**
     * Obtém um repositório específico pelo seu ID
     */
    async getRepository(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
    }): Promise<AzureReposRepository> {
        const instance = await this.azureRequest(params);
        const { data } = await instance.get(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}?api-version=7.1`,
        );
        return data;
    }

    async completePullRequest(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prId: number | string;
        completionOptions?: {
            deleteSourceBranch?: boolean;
            mergeStrategy?: string;
        };
    }): Promise<AzureRepoPullRequest> {
        const instance = await this.azureRequest(params);

        const updateData = {
            status: 'completed',
            completionOptions: params.completionOptions || {
                deleteSourceBranch: false,
                mergeStrategy: 'squash',
            },
        };

        const { data } = await instance.patch(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullrequests/${params.prId}?api-version=7.1`,
            updateData,
        );

        return data;
    }

    async listSubscriptionsByProject(params: {
        orgName: string;
        token: string;
        projectId: string;
    }): Promise<AzureRepoSubscription[]> {
        const instance = await this.azureRequest(params);

        const res = await instance.get(
            '/_apis/hooks/subscriptions?api-version=7.1',
        );

        return res.data.value.filter(
            (sub) => sub.publisherInputs?.projectId === params.projectId,
        );
    }

    async findExistingWebhook(params: {
        orgName: string;
        token: string;
        projectId: string;
        eventType: string;
        repoId: string;
        url: string;
    }): Promise<AzureRepoSubscription | undefined> {
        const instance = await this.azureRequest(params);

        const { data } = await instance.get(
            '/_apis/hooks/subscriptions?api-version=7.1',
        );

        return data.value.find(
            (sub) =>
                sub.eventType === params.eventType &&
                sub.publisherInputs?.projectId === params.projectId &&
                sub.publisherInputs?.repository === params.repoId &&
                sub.consumerInputs?.url?.includes(params.url),
        );
    }

    async deleteWebhookById(params: {
        orgName: string;
        token: string;
        subscriptionId: string;
    }): Promise<void> {
        const instance = await this.azureRequest(params);

        await instance.delete(
            `/_apis/hooks/subscriptions/${params.subscriptionId}?api-version=7.1`,
        );
    }

    async createSubscriptionForProject(params: {
        orgName: string;
        token: string;
        projectId: string;
        subscriptionPayload: any;
    }): Promise<AzureRepoSubscription> {
        const instance = await this.azureRequest(params);

        const res = await instance.post(
            '/_apis/hooks/subscriptions?api-version=7.1',
            params.subscriptionPayload,
        );
        return res.data;
    }

    async getLanguageRepository(params: {
        orgName: string;
        token: string;
        projectId: string;
    }): Promise<any> {
        const instance = await this.azureRequest(params);

        const { data } = await instance.get(
            `/${params.projectId}/_apis/projectanalysis/languagemetrics?api-version=7.1-preview.1`,
        );

        return data;
    }

    async getAuthenticatedUserId(params: {
        orgName: string;
        token: string;
    }): Promise<string | null> {
        const { orgName, token } = params;

        const instance = await this.azureRequest({
            orgName,
            token,
            useGraphApi: true,
        });

        const { data } = await instance.get(
            '/_apis/connectionData?connectOptions=IncludeServices&api-version=7.1-preview',
        );

        return data?.authenticatedUser?.id;
    }

    private async azureRequest({
        orgName,
        token,
        useGraphApi = false,
    }: {
        orgName: string;
        token: string;
        useGraphApi?: boolean;
    }): Promise<AxiosInstance> {
        const baseURL = useGraphApi
            ? `https://vssps.dev.azure.com/${orgName}`
            : `https://dev.azure.com/${orgName}`;

        const instance = axios.create({
            baseURL,
            timeout: INTEGRATION_REQUEST_TIMEOUT_MS,
            headers: {
                'Authorization': `Basic ${Buffer.from(`:${decrypt(token)}`).toString('base64')}`,
                'Content-Type': 'application/json',
            },
        });

        return instance;
    }

    async resolvePullRequestThread(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prId: number;
        threadId: number;
    }): Promise<any> {
        const instance = await this.azureRequest(params);

        const url = `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullRequests/${params.prId}/threads/${params.threadId}?api-version=7.1`;

        const payload = { status: 'closed' };

        const { data } = await instance.patch(url, payload);

        return data;
    }

    async getIterations(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prId: number | string;
    }): Promise<AzureRepoIteration[]> {
        const instance = await this.azureRequest(params);

        const { data } = await instance.get(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullrequests/${params.prId}/iterations?api-version=7.1`,
        );

        return data?.value;
    }

    async getChanges(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        pullRequestId: number | string;
        iterationId: number | string;
    }): Promise<AzureRepoChange[]> {
        const instance = await this.azureRequest(params);
        let allChanges: AzureRepoChange[] = [];
        let skip = 0;
        let top = 100;

        while (true) {
            const { data } = await instance.get(
                `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullrequests/${params.pullRequestId}/iterations/${params.iterationId}/changes?api-version=7.1&$top=${top}&$skip=${skip}`,
            );

            const changeEntries = data?.changeEntries ?? [];
            allChanges = [...allChanges, ...changeEntries];

            if (data.nextSkip === undefined) {
                break;
            }

            if (data.nextTop !== undefined) {
                top = data.nextTop;
            }

            skip = data.nextSkip;
        }

        return allChanges;
    }

    async getCommits(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        filters?: {
            author?: string;
            fromDate?: string;
            toDate?: string;
            branch?: string;
        };
    }): Promise<AzureRepoCommit[]> {
        const {
            orgName,
            token,
            projectId,
            repositoryId,
            filters = {},
        } = params;

        const instance = await this.azureRequest({ orgName, token });

        const apiPath = `/${projectId}/_apis/git/repositories/${repositoryId}/commits`;

        let queryParams: Record<string, string> = {
            'api-version': '7.1',
        };

        if (filters) {
            const searchCriteria = {
                author: filters.author,
                fromDate: filters.fromDate,
                toDate: filters.toDate,
                itemVersion: {
                    version: filters.branch,
                    versionType: filters.branch ? 'branch' : undefined,
                },
            };

            const dynamicParams = this._buildQueryParams(
                searchCriteria,
                'searchCriteria',
            );
            queryParams = { ...queryParams, ...dynamicParams };
        }

        const { data } = await instance.get(apiPath, { params: queryParams });

        return data?.value ?? [];
    }

    async getFileDiff(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        filePath: string;
        commitId: string;
        parentCommitId: string;
    }): Promise<any> {
        const instance = await this.azureRequest(params);

        const url = `/${params.projectId}/_apis/Contribution/HierarchyQuery/project/${params.projectId}?api-version=5.1-preview`;

        const body = {
            contributionIds: ['ms.vss-code-web.file-diff-data-provider'],
            dataProviderContext: {
                properties: {
                    repositoryId: params.repositoryId,
                    diffParameters: {
                        includeCharDiffs: true,
                        modifiedPath: params.filePath,
                        modifiedVersion: `GC${params.commitId}`,
                        originalPath: params.filePath,
                        originalVersion: `GC${params.parentCommitId}`,
                        partialDiff: true,
                    },
                },
            },
        };

        const { data } = await instance.post(url, body);
        return data;
    }

    async getFileContent(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        filePath: string;
        commitId: string;
    }): Promise<AzureRepoFileContent> {
        const instance = await this.azureRequest(params);

        try {
            // Primeira tentativa: usando a API items com versionDescriptor
            try {
                const { data } = await instance.get(
                    `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/items?path=${encodeURIComponent(
                        params.filePath,
                    )}&versionDescriptor.version=${params.commitId}&versionDescriptor.versionType=commit&includeContent=true&api-version=7.1`,
                );

                return data;
            } catch (initialError) {
                // Se a primeira tentativa falhar, tente a abordagem alternativa
                console.log(
                    `Primeira tentativa de obter arquivo falhou: ${initialError.message}. Tentando abordagem alternativa.`,
                );

                // Segunda tentativa: usando a URL diretamente
                // Remover a barra inicial no caminho do arquivo se existir
                const normalizedPath = params.filePath.startsWith('/')
                    ? params.filePath.substring(1)
                    : params.filePath;

                const { data } = await instance.get(
                    `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/items/${encodeURIComponent(
                        normalizedPath,
                    )}?version=${params.commitId}&versionType=commit&includeContent=true&api-version=7.1`,
                );
                return data;
            }
        } catch (error) {
            if (error.response && error.response.status === 404) {
                const wrapped: Error & { status?: number } = new Error(
                    `File not found: ${params.filePath} at commit ${params.commitId}`,
                    { cause: error },
                );
                wrapped.status = 404;
                throw wrapped;
            }

            // Verificar se é um erro de versão não encontrada
            if (
                error.response &&
                error.response.data &&
                error.response.data.message &&
                error.response.data.message.includes('TF401175')
            ) {
                throw new Error(
                    `O commit ${params.commitId} não pode ser encontrado no repositório ou você não tem permissão para acessá-lo.`,
                    { cause: error },
                );
            }

            // Se for outro erro, repasse
            throw error;
        }
    }

    async getDiff(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        baseCommit: string;
        targetCommitId: string;
        filePath?: string;
    }): Promise<any[]> {
        const instance = await this.azureRequest(params);

        const queryParams = [
            `baseVersionType=commit`,
            `baseVersion=${params.baseCommit}`,
            `targetVersionType=commit`,
            `targetVersion=${params.targetCommitId}`,
            `api-version=7.1`,
        ];

        if (params.filePath) {
            queryParams.push(`path=${encodeURIComponent(params.filePath)}`);
        }

        const url = `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/diffs/commits?${queryParams.join('&')}`;

        try {
            const { data } = await instance.get(url);
            return data?.changes || [];
        } catch (error) {
            if (
                error.response?.data?.message?.includes('TF401175') ||
                error.response?.status === 404
            ) {
                throw new Error(
                    `Error fetching diff for file '${params.filePath || 'ALL'}' between ${params.baseCommit} and ${params.targetCommitId}.`,
                    { cause: error },
                );
            }
            throw error;
        }
    }

    async getChangesForCommit(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        commitId: string;
    }): Promise<AzureRepoChange[]> {
        const instance = await this.azureRequest(params);

        try {
            const { data } = await instance.get(
                `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/commits/${params.commitId}/changes?api-version=7.1`,
            );

            return data?.changes || [];
        } catch (error) {
            // Verificar se é um erro de versão não encontrada
            if (
                error.response &&
                error.response.data &&
                error.response.data.message &&
                error.response.data.message.includes('TF401175')
            ) {
                throw new Error(
                    `O commit ${params.commitId} não pode ser encontrado no repositório ou você não tem permissão para acessá-lo.`,
                    { cause: error },
                );
            }

            // Se for outro erro, repasse
            throw error;
        }
    }

    async createIssueComment(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prId: number;
        comment: string;
    }): Promise<any> {
        const instance = await this.azureRequest(params);

        const payload = {
            comments: [
                {
                    content: params.comment,
                    commentType: AzureRepoCommentType.TEXT,
                },
            ],
            status: 'active',
        };

        const { data } = await instance.post(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullRequests/${params.prId}/threads?api-version=7.1`,
            payload,
        );

        return data;
    }

    async votePullRequest(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prId: number;
        reviewerId: string;
        vote: number; // 10 = approve, -10 = reject/request changes
    }): Promise<any> {
        const instance = await this.azureRequest(params);

        const url = `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullRequests/${params.prId}/reviewers/${params.reviewerId}?api-version=7.1`;

        const payload = { vote: params.vote };

        const { data } = await instance.put(url, payload);
        return data;
    }

    async getListOfPullRequestReviewers(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prId: number;
    }): Promise<AzureRepoReviewerWithVote[]> {
        const instance = await this.azureRequest(params);

        const url = `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullRequests/${params.prId}/reviewers/?api-version=7.1`;

        const { data } = await instance.get(url);

        return data?.value ?? [];
    }

    async getRepositoryContentFile(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        filePath: string;
        commitId?: string;
        branch?: string;
    }): Promise<{ content: string } | null> {
        const instance = await this.azureRequest(params);

        // Azure DevOps expects plain branch names for versionDescriptor.version.
        // Normalize typical refs (e.g., "refs/heads/main" -> "main").
        const normalizedBranch = params.branch?.replace(/^refs\/heads\//, '');

        const versionQuery = normalizedBranch
            ? `versionDescriptor.version=${encodeURIComponent(normalizedBranch)}&versionDescriptor.versionType=branch`
            : params.commitId
              ? `versionDescriptor.version=${encodeURIComponent(params.commitId)}&versionDescriptor.versionType=commit`
              : '';

        const queryParts = [
            `path=${encodeURIComponent(params.filePath)}`,
            versionQuery,
            'includeContent=true',
            'resolveLfs=true',
            'api-version=7.1',
        ].filter(Boolean);

        const { data } = await instance.get(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/items?${queryParts.join('&')}`,
        );

        return {
            content: data?.content || '',
        };
    }

    async getCommitsForPullRequest(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prId: number | string;
    }): Promise<any[]> {
        const instance = await this.azureRequest(params);

        const { data } = await instance.get(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullrequests/${params.prId}/commits?api-version=7.1`,
        );

        return data?.value ?? [];
    }

    async getCommit(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        commitId: string;
    }): Promise<any | null> {
        const instance = await this.azureRequest(params);

        const { data } = await instance.get(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/commits/${params.commitId}?api-version=7.1`,
        );

        return data ?? null;
    }

    async updatePullRequestDescription(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prId: number;
        description: string;
    }): Promise<any> {
        const instance = await this.azureRequest(params);

        const { data } = await instance.patch(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullRequests/${params.prId}?api-version=7.1`,
            {
                // Azure rejects PR descriptions > 4000 chars with HTTP 400
                // (`InvalidArgumentValueException`). Truncate at the
                // adapter boundary so callers don't have to know about
                // platform-specific limits.
                description: fitPRDescription(
                    params.description,
                    PlatformType.AZURE_REPOS,
                ),
            },
        );

        return data;
    }

    async updateCommentOnPullRequest(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prNumber: number;
        threadId: number;
        commentId: number;
        content: string;
    }): Promise<any> {
        const instance = await this.azureRequest(params);

        const { data } = await instance.patch(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullRequests/${params.prNumber}/threads/${params.threadId}/comments/${params.commentId}?api-version=7.1`,
            {
                content: params.content,
                commentType: AzureRepoCommentType.TEXT,
            },
        );

        return data;
    }

    async replyToThreadComment(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prId: number;
        threadId: number;
        comment: string;
    }): Promise<any> {
        const instance = await this.azureRequest(params);

        const payload = {
            content: params.comment,
            commentType: AzureRepoCommentType.TEXT,
        };

        const { data } = await instance.post(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullRequests/${params.prId}/threads/${params.threadId}/comments?api-version=7.1`,
            payload,
        );

        return data;
    }

    async getUser(params: {
        orgName: string;
        token: string;
        identifier: string;
    }): Promise<any> {
        const instance = await this.azureRequest({
            ...params,
            useGraphApi: true,
        });

        const isDescriptor = /^(aad|msa|vss|svc)\./.test(params.identifier);

        const url = isDescriptor
            ? `https://vssps.dev.azure.com/${params.orgName}/_apis/graph/users/${params.identifier}?api-version=7.1-preview.1`
            : `https://vssps.dev.azure.com/${params.orgName}/_apis/graph/users?filterValue=${encodeURIComponent(params.identifier)}&api-version=7.1-preview.1`;

        const { data } = await instance.get(url);

        if (isDescriptor) {
            return data ?? null;
        }

        const users = data?.value ?? [];

        // Priorize users from Azure AD or MSA
        const preferredUser = users.find(
            (u: any) => u.origin === 'aad' || u.origin === 'msa',
        );

        return preferredUser ?? users[0] ?? null;
    }

    async listOrganizationUsers(params: {
        orgName: string;
        token: string;
    }): Promise<any[]> {
        const instance = await this.azureRequest({
            ...params,
            useGraphApi: true,
        });

        const users: any[] = [];
        let continuationToken: string | undefined;

        do {
            const requestConfig: {
                params: Record<string, string>;
                headers?: Record<string, string>;
            } = {
                params: {
                    'api-version': '7.1-preview.1',
                    'subjectTypes': 'aad,msa,vss,svc',
                },
            };

            if (continuationToken) {
                requestConfig.headers = {
                    'x-ms-continuationtoken': continuationToken,
                };
            }

            const response = await instance.get(
                '/_apis/graph/users',
                requestConfig,
            );
            users.push(...(response.data?.value ?? []));

            const headerValue =
                response.headers['x-ms-continuationtoken'] ??
                response.headers['X-MS-ContinuationToken'];

            if (Array.isArray(headerValue)) {
                continuationToken = headerValue[0];
            } else {
                continuationToken = headerValue;
            }
        } while (continuationToken);

        return users;
    }

    async listRepositoryFiles(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        filters?: {
            branch?: string;
            path?: string;
        };
    }): Promise<AzureRepoFileItem[]> {
        const { projectId, repositoryId, filters = {} } = params;

        const instance = await this.azureRequest(params);

        const apiPath = `/${projectId}/_apis/git/repositories/${repositoryId}/items`;

        const branch = filters?.branch
            ? filters.branch.replace('refs/heads/', '')
            : undefined;

        const query = {
            'api-version': '7.1',
            'recursionLevel': 'full',
            'includeContentMetadata': 'true',
            'versionDescriptor': {
                version: branch,
                versionType: branch ? 'branch' : undefined,
            },
            'scopePath': filters?.path,
        };

        const queryParams = this._buildQueryParams(query);

        const { data } = await instance.get(apiPath, { params: queryParams });

        return data?.value ?? [];
    }

    mapAzureStatusToFileChangeStatus(status: string): FileChange['status'] {
        const tokens = new Set(
            status.split(',').map((t) => t.trim().toLowerCase()),
        );
        if (tokens.has('delete') || tokens.has('removed')) return 'removed';
        if (tokens.has('add') || tokens.has('added')) return 'added';
        if (
            tokens.has('rename') ||
            tokens.has('renamed') ||
            tokens.has('sourcerename') ||
            tokens.has('targetrename')
        ) {
            return 'renamed';
        }
        if (tokens.has('copy') || tokens.has('copied')) return 'copied';
        if (tokens.has('edit') || tokens.has('modified')) return 'modified';
        if (tokens.has('unchanged')) return 'unchanged';
        return 'changed';
    }

    /**
     * Recursively builds a flat parameter object from a nested criteria object.
     * @param obj The object to flatten (e.g., searchCriteria).
     * @param prefix The base key to prefix nested properties with.
     * @returns A flat object with dot-notated keys.
     */
    private _buildQueryParams(
        obj: Record<string, any>,
        prefix?: string,
    ): Record<string, string> {
        const params: Record<string, string> = {};

        for (const [key, value] of Object.entries(obj)) {
            // Skip null or undefined values
            if (value === null || value === undefined) {
                continue;
            }

            const newKey = prefix ? `${prefix}.${key}` : key;

            // If the value is a nested object, recurse deeper
            if (typeof value === 'object' && !Array.isArray(value)) {
                const nestedParams = this._buildQueryParams(value, newKey);

                if (Object.keys(nestedParams).length === 0) {
                    continue; // Skip empty nested objects
                }

                Object.assign(params, nestedParams); // Merge the results
            } else {
                // Otherwise, it's a primitive value, so add it
                params[newKey] = String(value);
            }
        }

        return params;
    }

    async getRepositoryTree(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        recursive?: boolean;
        scopePath?: string;
    }): Promise<any[]> {
        const instance = await this.azureRequest(params);

        const queryParams = new URLSearchParams();
        queryParams.append('api-version', '7.1');
        queryParams.append(
            'recursionLevel',
            params.recursive ? 'full' : 'oneLevel',
        );

        if (params.scopePath) {
            queryParams.append('scopePath', params.scopePath);
        }

        const { data } = await instance.get(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/items?${queryParams.toString()}`,
        );

        return data?.value || [];
    }

    async getRepositoryTreeByDirectory(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        scopePath?: string;
        recursionLevel?: 'OneLevel' | 'Full' | 'None';
    }): Promise<any[]> {
        const instance = await this.azureRequest(params);

        const queryParams = new URLSearchParams();
        queryParams.append('api-version', '7.1');
        queryParams.append(
            'recursionLevel',
            params.recursionLevel || 'OneLevel', // ← Padrão: apenas 1 nível
        );

        if (params.scopePath) {
            queryParams.append('scopePath', params.scopePath);
        }

        const { data } = await instance.get(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/items?${queryParams.toString()}`,
        );

        return data?.value || [];
    }

    async updateThreadComment(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        prId: number;
        threadId: number;
        commentId: number;
        body: string;
    }): Promise<AzureRepoPRThread> {
        const { projectId, repositoryId, prId, threadId, commentId, body } =
            params;

        const instance = await this.azureRequest(params);

        const apiPath = `/${projectId}/_apis/git/repositories/${repositoryId}/pullRequests/${prId}/threads/${threadId}/comments/${commentId}`;

        const queryParams = {
            'api-version': '7.1',
        };

        const payload = {
            content: body,
            commentType: AzureRepoCommentType.TEXT,
        };

        const { data } = await instance.patch(apiPath, payload, {
            params: queryParams,
        });

        return data;
    }

    /**
     * Lists repository items recursively at a given branch (default branch or specific ref)
     */
    async listRepositoryItemsRecursive(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        branch: string;
    }): Promise<Array<{ path: string; objectId: string; size?: number }>> {
        const instance = await this.azureRequest(params);
        const { data } = await instance.get(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/items?recursionLevel=Full&version=${encodeURIComponent(
                params.branch,
            )}&versionType=branch&includeLinks=false&api-version=7.1`,
        );
        const values = (data?.value || []) as any[];
        return values
            .filter((v) => v?.gitObjectType === 'blob')
            .map((v) => ({
                path: String(v?.path || '').replace(/^\//, ''),
                objectId: v?.objectId,
                size: v?.size,
            }));
    }

    async uploadFilesToNewBranch(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        branchName: string;
        baseBranch?: string;
        commitMessage: string;
        author?: { name: string; email?: string };
        changes: Array<{
            changeType: 'add' | 'edit' | 'delete';
            filePath: string;
            content?: string;
        }>;
    }): Promise<any> {
        const instance = await this.azureRequest(params);
        const normalizedBranch = params.branchName.replace(
            /^refs\/heads\//,
            '',
        );

        const sourceObjectId = await this.getBranchObjectId({
            orgName: params.orgName,
            token: params.token,
            projectId: params.projectId,
            repositoryId: params.repositoryId,
            branchName: normalizedBranch,
        });

        const baseObjectId =
            !sourceObjectId && params.baseBranch
                ? await this.getBranchObjectId({
                      orgName: params.orgName,
                      token: params.token,
                      projectId: params.projectId,
                      repositoryId: params.repositoryId,
                      branchName: params.baseBranch,
                  })
                : null;

        const oldObjectId =
            sourceObjectId ||
            baseObjectId ||
            '0000000000000000000000000000000000000000';

        const url = `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pushes?api-version=7.1`;

        const payload = {
            refUpdates: [
                {
                    name: `refs/heads/${normalizedBranch}`,
                    oldObjectId,
                },
            ],
            commits: [
                {
                    comment: params.commitMessage,
                    ...(params.author
                        ? {
                              author: {
                                  name: params.author.name,
                                  email: params.author.email,
                              },
                              committer: {
                                  name: params.author.name,
                                  email: params.author.email,
                              },
                          }
                        : {}),
                    changes: params.changes.map((change) => ({
                        changeType: change.changeType,
                        item: {
                            path: change.filePath,
                        },
                        newContent: change.content
                            ? {
                                  content: change.content,
                                  contentType: 'rawtext',
                              }
                            : undefined,
                    })),
                },
            ],
        };

        const { data } = await instance.post(url, payload);
        return data;
    }

    async branchExists(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        branchName: string;
    }): Promise<boolean> {
        const branchObjectId = await this.getBranchObjectId(params);
        return Boolean(branchObjectId);
    }

    async getBranchObjectId(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        branchName: string;
    }): Promise<string | null> {
        const instance = await this.azureRequest(params);
        const normalizedBranch = params.branchName.replace(
            /^refs\/heads\//,
            '',
        );

        const refsResponse = await instance.get(
            `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/refs`,
            {
                params: {
                    'filter': `heads/${normalizedBranch}`,
                    'api-version': '7.1',
                },
            },
        );

        const branchRef = refsResponse.data?.value?.find(
            (ref: { name?: string; objectId?: string }) =>
                ref?.name === `refs/heads/${normalizedBranch}`,
        );

        return branchRef?.objectId || null;
    }

    async createPullRequest(params: {
        orgName: string;
        token: string;
        projectId: string;
        repositoryId: string;
        sourceBranch: string;
        targetBranch: string;
        title: string;
        description?: string;
    }): Promise<AzureRepoPullRequest> {
        const instance = await this.azureRequest(params);

        const normalizedSourceBranch = params.sourceBranch.replace(
            /^refs\/heads\//,
            '',
        );
        const normalizedTargetBranch = params.targetBranch.replace(
            /^refs\/heads\//,
            '',
        );

        const url = `/${params.projectId}/_apis/git/repositories/${params.repositoryId}/pullrequests?api-version=7.1`;

        const payload = {
            sourceRefName: `refs/heads/${normalizedSourceBranch}`,
            targetRefName: `refs/heads/${normalizedTargetBranch}`,
            title: params.title,
            description: fitPRDescription(
                params.description || '',
                PlatformType.AZURE_REPOS,
            ),
        };

        const { data } = await instance.post(url, payload);
        return data;
    }
}
