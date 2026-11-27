import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable, forwardRef } from '@nestjs/common';

import { Reaction } from '@libs/code-review/domain/codeReviewFeedback/enums/codeReviewCommentReaction.enum';
import { extractOrganizationAndTeamData } from '@libs/common/utils/helpers';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { CreateAuthIntegrationResult } from '@libs/core/domain/enums/create-auth-integration-status.enum';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import {
    CommentResult,
    FileChange,
    Repository,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Commit } from '@libs/core/infrastructure/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { TreeItem } from '@libs/core/infrastructure/config/types/general/tree.type';
import {
    ConnectionRepositoryHint,
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import {
    CodeManagementConnectionStatus,
    type HostAccount,
    ICodeManagementService,
    PullRequestFileChange,
} from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';
import {
    CheckEvidence,
    CheckEvidenceSupport,
    GetCheckEvidenceParams,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/checkEvidence.type';
import { GitCloneParams } from '@libs/platform/domain/platformIntegrations/types/codeManagement/gitCloneParams.type';
import {
    CodeManagementIssue,
    GetIssueParams,
    ListIssuesParams,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/issues.type';
import {
    PullRequest,
    PullRequestAuthor,
    PullRequestReviewComment,
    PullRequestReviewState,
    PullRequestsWithChangesRequested,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { RepositoryFile } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositoryFile.type';
import {
    RepositoryAccessDiagnosis,
    UNKNOWN_REPOSITORY_ACCESS,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositoryAccessDiagnosis.type';
import { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { connectionServerKey } from '@libs/integrations/domain/integrations/utils/connection-host';
import { PlatformIntegrationFactory } from './platformIntegration.factory';
import type {
    ApprovalTeamMembership,
    ApprovalTeamMembershipParams,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/approvalTeamMembership.type';
import { WebhookSetupResult } from '@libs/platform/domain/platformIntegrations/types/codeManagement/webhook-setup.type';

@Injectable()
export class CodeManagementService implements ICodeManagementService {
    private readonly logger = createLogger(CodeManagementService.name);

    constructor(
        @Inject(forwardRef(() => INTEGRATION_SERVICE_TOKEN))
        private readonly integrationService: IIntegrationService,
        private platformIntegrationFactory: PlatformIntegrationFactory,
    ) {}

    /**
     * The platform of the workspace's Git connection; with several, the one
     * listing the given repository, else null. A failed lookup throws, so a
     * caller can tell it from an absence.
     */
    async findTypeIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
        repository?: ConnectionRepositoryHint,
    ): Promise<PlatformType | null> {
        const resolved =
            await this.integrationService.resolveCodeManagementConnection(
                organizationAndTeamData,
                repository ? { repository } : {},
            );
        return resolved.platform;
    }

    /**
     * Picks the connection a call is for and names it on the params handed
     * to the provider, so its credential lookup reads that connection. The
     * caller's objects are never written to.
     */
    private async route<P>(
        params: P,
        type?: PlatformType,
    ): Promise<{ type: PlatformType | null; params: P }> {
        const organizationAndTeamData = extractOrganizationAndTeamData(params);

        if (organizationAndTeamData?.integrationId && type) {
            return { type, params };
        }
        // Lookups that find the workspace itself (by repository and host)
        // carry none yet: nothing to resolve, and an unscoped resolve would
        // read every tenant's connections.
        if (
            !organizationAndTeamData?.organizationId ||
            !organizationAndTeamData?.teamId
        ) {
            return { type: type ?? null, params };
        }

        try {
            const resolved =
                await this.integrationService.resolveCodeManagementConnection(
                    organizationAndTeamData,
                    {
                        platform: type,
                        repository: repositoryHint(params),
                    },
                );

            const routedType = type ?? resolved.platform;
            const integrationId = resolved.integration?.uuid;
            if (!integrationId) {
                return { type: routedType, params };
            }

            return {
                type: routedType,
                params: {
                    ...params,
                    organizationAndTeamData: {
                        ...organizationAndTeamData,
                        integrationId,
                    },
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Failed to resolve the Git connection',
                context: CodeManagementService.name,
                error,
                metadata: {
                    organizationId: organizationAndTeamData?.organizationId,
                    teamId: organizationAndTeamData?.teamId,
                    platform: type,
                },
            });
            return { type: type ?? null, params };
        }
    }

    /**
     * The connection listing the repository, or undefined when none or
     * several do. Never throws.
     */
    async connectionIdFor(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: ConnectionRepositoryHint,
    ): Promise<string | undefined> {
        try {
            const { integration } =
                await this.integrationService.resolveCodeManagementConnection(
                    organizationAndTeamData,
                    { repository },
                );
            return integration?.uuid;
        } catch (error) {
            this.logger.warn({
                message: 'Could not resolve the Git connection of a repository',
                context: CodeManagementService.name,
                error,
                metadata: {
                    organizationId: organizationAndTeamData?.organizationId,
                    teamId: organizationAndTeamData?.teamId,
                    repository,
                },
            });
            return undefined;
        }
    }

    /**
     * `PLATFORM|host` of the connection a call would use, or undefined when
     * none answers. Never throws.
     */
    async connectionServerKey(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string | undefined> {
        try {
            const { integration } =
                await this.integrationService.resolveCodeManagementConnection(
                    organizationAndTeamData,
                );
            return integration
                ? connectionServerKey(
                      integration.platform,
                      integration.authIntegration?.authDetails,
                  )
                : undefined;
        } catch (error) {
            this.logger.warn({
                message: 'Could not resolve the server of the Git connection',
                context: CodeManagementService.name,
                error,
                metadata: {
                    organizationId: organizationAndTeamData?.organizationId,
                    teamId: organizationAndTeamData?.teamId,
                    integrationId: organizationAndTeamData?.integrationId,
                },
            });
            return undefined;
        }
    }

    /**
     * With several connections, pass the repository the caller is about:
     * without it the answer is null unless they share one platform.
     */
    async getTypeIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
        repository?: ConnectionRepositoryHint,
    ): Promise<PlatformType> {
        try {
            return await this.findTypeIntegration(
                organizationAndTeamData,
                repository,
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to resolve integration type',
                context: CodeManagementService.name,
                error,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
            });
            return null;
        }
    }

    async listIssues(
        params: ListIssuesParams,
        type?: PlatformType,
    ): Promise<CodeManagementIssue[]> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return [];
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        if (typeof codeManagementService.listIssues !== 'function') {
            throw new Error(
                `Reading issues is not supported for platform ${type}`,
            );
        }

        return codeManagementService.listIssues(params);
    }

    async getApprovalTeamMembership(
        params: ApprovalTeamMembershipParams,
    ): Promise<ApprovalTeamMembership> {
        try {
            const routed = await this.route(params);
            const type = routed.type;
            params = routed.params;
            if (!type) return 'unavailable';
            const provider =
                this.platformIntegrationFactory.getCodeManagementService(type);
            return (
                (await provider.getApprovalTeamMembership?.(params)) ??
                'unavailable'
            );
        } catch {
            return 'unavailable';
        }
    }

    async getIssue(
        params: GetIssueParams,
        type?: PlatformType,
    ): Promise<CodeManagementIssue | null> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return null;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        if (typeof codeManagementService.getIssue !== 'function') {
            throw new Error(
                `Reading issues is not supported for platform ${type}`,
            );
        }

        return codeManagementService.getIssue(params);
    }

    /**
     * Whether the team's connected code host supports reading native issues.
     * False for hosts without an issue tracker (Azure Repos → none; Bitbucket
     * Data Center → none, refined via `supportsIssues`). Used to gate installing
     * the generic issues MCP.
     */
    async isIssuesSupported(
        organizationAndTeamData: OrganizationAndTeamData,
        repository?: ConnectionRepositoryHint,
    ): Promise<boolean> {
        const routed = await this.route({
            organizationAndTeamData,
            repository,
        });
        const type = routed.type;

        if (!type) {
            return false;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        if (typeof codeManagementService.listIssues !== 'function') {
            return false;
        }

        if (typeof codeManagementService.supportsIssues === 'function') {
            return codeManagementService.supportsIssues(
                routed.params.organizationAndTeamData,
            );
        }

        return true;
    }

    /**
     * CI results the customer's own pipeline produced for a commit.
     *
     * Unlike `listIssues`, this never throws: nobody asked for this evidence,
     * it only enriches a review, and a host that cannot supply it — or an API
     * that is briefly unavailable — must not take the review down with it.
     */
    async getFilePatches(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { id?: string; name: string; owner?: string };
            prNumber: number;
            paths: string[];
        },
        type?: PlatformType,
    ): Promise<Array<{ path: string; patch: string }>> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return [];
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        if (typeof codeManagementService.getFilePatches !== 'function') {
            return [];
        }

        try {
            return await codeManagementService.getFilePatches(params);
        } catch (error) {
            this.logger.warn({
                message: 'Failed to read file patches',
                context: CodeManagementService.name,
                error,
                metadata: {
                    organizationId:
                        params.organizationAndTeamData?.organizationId,
                    platform: type,
                    prNumber: params.prNumber,
                    repository: params.repository?.name,
                },
            });
            return [];
        }
    }

    async getCheckEvidence(
        params: GetCheckEvidenceParams,
        type?: PlatformType,
    ): Promise<CheckEvidence[]> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return [];
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        if (typeof codeManagementService.getCheckEvidence !== 'function') {
            return [];
        }

        try {
            return await codeManagementService.getCheckEvidence(params);
        } catch (error) {
            this.logger.warn({
                message: 'Failed to read CI check evidence',
                context: CodeManagementService.name,
                error,
                metadata: {
                    platform: type,
                    commitSha: params.commitSha,
                },
            });
            return [];
        }
    }

    /**
     * What the team's host can report. Absent probe with a reader present is
     * read as status-only — claiming annotation support we cannot deliver
     * would make callers treat an empty result as "clean".
     */
    async supportsCheckEvidence(
        organizationAndTeamData: OrganizationAndTeamData,
        type?: PlatformType,
        repository?: ConnectionRepositoryHint,
    ): Promise<CheckEvidenceSupport> {
        const none: CheckEvidenceSupport = {
            statuses: false,
            annotations: false,
        };

        const routed = await this.route(
            { organizationAndTeamData, repository },
            type,
        );
        type = routed.type;
        organizationAndTeamData = routed.params.organizationAndTeamData;

        if (!type) {
            return none;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        if (typeof codeManagementService.getCheckEvidence !== 'function') {
            return none;
        }

        if (typeof codeManagementService.supportsCheckEvidence === 'function') {
            return codeManagementService.supportsCheckEvidence(
                organizationAndTeamData,
            );
        }

        return { statuses: true, annotations: false };
    }

    async findRepositoryByName(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            name: string;
        },
        type?: PlatformType,
    ): Promise<Partial<Repository> | null> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return null;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.findRepositoryByName(params);
    }

    async createPullRequestWithFiles(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { id: string; name: string; fullName?: string };
            sourceBranch?: string;
            targetBranch?: string;
            baseBranch?: string;
            title?: string;
            description?: string;
            commitMessage?: string;
            author?: { name: string; email?: string };
            files: PullRequestFileChange[];
        },
        type?: PlatformType,
    ): Promise<Partial<PullRequest> | null> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return null;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.createPullRequestWithFiles(params);
    }

    async uploadFiles(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { id: string; name: string; fullName?: string };
            branchName?: string;
            baseBranch?: string;
            files: PullRequestFileChange[];
            message?: string;
            author?: { name: string; email?: string };
        },
        type?: PlatformType,
    ): Promise<boolean> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return false;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.uploadFiles(params);
    }

    async getCommits(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository?: Partial<Repository>;
            filters?: {
                startDate?: Date;
                endDate?: Date;
                author?: string;
                branch?: string;
            };
        },
        type?: PlatformType,
    ): Promise<Commit[]> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return [];
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getCommits(params);
    }

    async getRepositories(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            filters?: {
                archived?: boolean;
                organizationSelected?: string;
                visibility?: 'all' | 'public' | 'private';
                language?: string;
            };
            options?: {
                includePullRequestMetrics?: {
                    lastNDays?: number;
                    limit?: number;
                };
                // A screen is waiting: providers that back off on rate limits
                // give up sooner. Only Bitbucket Cloud reads it today.
                interactive?: boolean;
            };
        },
        type?: PlatformType,
    ): Promise<Repositories[]> {
        const connections = await this.connectionsToList(
            params.organizationAndTeamData,
            type,
        );
        if (connections.length > 1) {
            return this.repositoriesOfEach(params, connections);
        }

        ({ type, params } = await this.route(params, type));

        if (!type) {
            return [];
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getRepositories(params);
    }

    /**
     * The workspace's Git connections a listing with no connection named has
     * to cover: every one of them (of the given platform) when the call could
     * not be routed to a single one.
     */
    private async connectionsToList(
        organizationAndTeamData: OrganizationAndTeamData,
        type?: PlatformType,
    ): Promise<Array<{ uuid: string; platform: PlatformType }>> {
        if (
            !organizationAndTeamData?.teamId ||
            organizationAndTeamData.integrationId
        ) {
            return [];
        }
        const resolved =
            await this.integrationService.resolveCodeManagementConnection(
                organizationAndTeamData,
                { platform: type },
            );
        if (!resolved.ambiguous) return [];
        const connections =
            (await this.integrationService.find({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
                status: true,
            })) ?? [];
        return connections
            .filter((connection) => !type || connection.platform === type)
            .map((connection) => ({
                uuid: connection.uuid,
                platform: connection.platform,
            }));
    }

    /** Lists each connection's repositories, tagged with it; one failing leaves the others listed. */
    private async repositoriesOfEach<
        P extends { organizationAndTeamData: OrganizationAndTeamData },
    >(
        params: P,
        connections: Array<{ uuid: string; platform: PlatformType }>,
    ): Promise<Repositories[]> {
        const lists = await Promise.allSettled(
            connections.map(async (connection) =>
                (
                    (await this.platformIntegrationFactory
                        .getCodeManagementService(connection.platform)
                        .getRepositories({
                            ...params,
                            organizationAndTeamData: {
                                ...params.organizationAndTeamData,
                                integrationId: connection.uuid,
                            },
                        })) ?? []
                ).map((repository: Repositories) => ({
                    ...repository,
                    connectionId: connection.uuid,
                })),
            ),
        );
        lists.forEach((list, index) => {
            if (list.status === 'rejected') {
                this.logger.warn({
                    message: 'connection_repositories_unavailable',
                    context: CodeManagementService.name,
                    error: list.reason,
                    metadata: {
                        organizationId:
                            params.organizationAndTeamData.organizationId,
                        teamId: params.organizationAndTeamData.teamId,
                        integrationId: connections[index].uuid,
                    },
                });
            }
        });
        if (lists.every((list) => list.status === 'rejected')) {
            throw (lists[0] as PromiseRejectedResult).reason;
        }
        return lists.flatMap((list) =>
            list.status === 'fulfilled' ? list.value : [],
        );
    }
    async getListMembers(params: any, type?: PlatformType): Promise<any> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return [];
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return await codeManagementService.getListMembers(params);
    }

    async verifyConnection(
        params: any,
        type?: PlatformType,
    ): Promise<CodeManagementConnectionStatus> {
        ({ type, params } = await this.route(params, type));

        if (!type) return null;

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.verifyConnection(params);
    }

    async createAuthIntegration(
        params: any,
        type?: PlatformType,
    ): Promise<CreateAuthIntegrationResult> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.createAuthIntegration(params);
    }

    async updateAuthIntegration(
        params: any,
        type?: PlatformType,
    ): Promise<void> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.updateAuthIntegration(params);
    }

    async createOrUpdateIntegrationConfig(
        params: any,
        type?: PlatformType,
    ): Promise<void> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.createOrUpdateIntegrationConfig(params);
    }

    async getPullRequests(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository?: {
                id: string;
                name: string;
            };
            filters?: {
                startDate?: Date;
                endDate?: Date;
                state?: PullRequestState;
                author?: string;
                branch?: string;
                number?: number;
                title?: string;
                url?: string;
            };
        },
        type?: PlatformType,
    ): Promise<PullRequest[]> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getPullRequests(params);
    }

    async getPullRequestsWithFiles(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            filters: any;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getPullRequestsWithFiles(params);
    }

    async getPullRequestsForRTTM(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            filters: any;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getPullRequestsForRTTM(params);
    }

    async getPullRequestAuthors(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            determineBots?: boolean;
            requireLoaded?: boolean;
        },
        type?: PlatformType,
    ): Promise<PullRequestAuthor[]> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return [];
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getPullRequestAuthors(params);
    }

    async canFindRecentPullRequestAuthors(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<boolean> {
        const type = await this.getTypeIntegration(organizationAndTeamData);

        if (!type) {
            return false;
        }

        return (
            typeof this.platformIntegrationFactory.getCodeManagementService(
                type,
            ).findRecentPullRequestAuthors === 'function'
        );
    }

    /** `null` when the connected provider cannot answer this. */
    async findRecentPullRequestAuthors(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            authorIds: string[];
        },
        type?: PlatformType,
    ): Promise<PullRequestAuthor[] | null> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return null;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        if (!codeManagementService.findRecentPullRequestAuthors) {
            return null;
        }

        return codeManagementService.findRecentPullRequestAuthors(params);
    }

    async getOrganizations(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getOrganizations(params);
    }

    async getFilesByPullRequestId(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string; fullName?: string };
            prNumber: number;
            // Cache identity requires both PR refs. A retarget can change the
            // full file list without changing the head.
            headSha?: string;
            baseSha?: string;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getFilesByPullRequestId(params);
    }

    async getChangedFilesSinceLastCommit(params: any, type?: PlatformType) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getChangedFilesSinceLastCommit(params);
    }

    async getPullRequestFilesAtCommit(
        params: Parameters<
            ICodeManagementService['getPullRequestFilesAtCommit']
        >[0],
        type?: PlatformType,
    ): Promise<FileChange[] | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getPullRequestFilesAtCommit(params);
    }

    async createCommentInPullRequest(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string; fullName?: string };
            prNumber: number;
            overallComment: any;
            lineComments?: any;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.createCommentInPullRequest(params);
    }

    async getRepositoryContentFile(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string; fullName?: string };
            file: any;
            pullRequest: any;
            suppressNotFoundLogs?: boolean;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getRepositoryContentFile(params);
    }

    async getRepositoryContentBatch(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: any; fullName?: string };
            files: Array<{ filename: string; sha?: string }>;
            pullRequest?: any;
        },
        type?: PlatformType,
    ): Promise<Map<string, any> | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getRepositoryContentBatch(params);
    }

    async getUsersByUsername(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            usernames: string[];
        },
        type?: PlatformType,
    ): Promise<Map<string, any> | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getUsersByUsername(params);
    }

    async getPullRequestByNumber(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string; fullName?: string };
            prNumber: number;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getPullRequestByNumber(params);
    }

    async createReviewComment(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: {
                name: string;
                id: string;
                language: string;
                fullName?: string;
            };
            prNumber: number;
            lineComment: any;
            commit: any;
            language: string;
            suggestionCopyPrompt?: boolean;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.createReviewComment(params);
    }

    async getCommitsForPullRequestForCodeReview(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string; fullName?: string };
            prNumber: number;
            // Same pattern as getFilesByPullRequestId — optional cache key.
            headSha?: string;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getCommitsForPullRequestForCodeReview(
            params,
        );
    }

    async createIssueComment(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string; fullName?: string };
            prNumber: number;
            body: string;
            suggestion?: ISuggestionByPR;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.createIssueComment(params);
    }

    async createSingleIssueComment(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string; fullName?: string };
            prNumber: number;
            body: string;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        if (type === PlatformType.GITLAB) {
            return codeManagementService.createSingleIssueComment(params);
        }
        return codeManagementService.createIssueComment(params);
    }

    async updateIssueComment(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string; fullName?: string };
            prNumber: number;
            body: string;
            commentId: number;
            noteId?: number;
            threadId?: number;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.updateIssueComment(params);
    }

    async findTeamAndOrganizationIdByConfigKey(
        params: any,
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.findTeamAndOrganizationIdByConfigKey(
            params,
        );
    }

    async getDefaultBranch(params: any, type?: PlatformType) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getDefaultBranch(params);
    }

    async getPullRequestReviewComment(params: any, type?: PlatformType) {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return [];
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getPullRequestReviewComment(params);
    }

    /**
     * Repository-level comment sample. Returns null when the active platform
     * has no such endpoint, which is the caller's signal to fall back to the
     * per-PR walk rather than treat it as "no comments".
     */
    async getRecentRepositoryComments(params: any, type?: PlatformType) {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return null;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        if (!codeManagementService.getRecentRepositoryComments) {
            return null;
        }

        return codeManagementService.getRecentRepositoryComments(params);
    }

    async createResponseToComment(params: any, type?: PlatformType) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.createResponseToComment(params);
    }

    async getPullRequest(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: Partial<Repository>;
            prNumber: number;
            includeLabels?: boolean;
        },
        type?: PlatformType,
    ): Promise<PullRequest | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getPullRequest(params);
    }

    async updateDescriptionInPullRequest(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string; fullName?: string };
            prNumber: number;
            summary: string;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.updateDescriptionInPullRequest(params);
    }

    async getAuthenticationOAuthToken(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getAuthenticationOAuthToken(params);
    }

    async countReactions(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            comments: any[];
            pr: any;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return [];
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.countReactions(params);
    }

    async minimizeComment(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            commentId: string;
            reason?:
                | 'ABUSE'
                | 'OFF_TOPIC'
                | 'OUTDATED'
                | 'RESOLVED'
                | 'DUPLICATE'
                | 'SPAM';
        },
        type?: PlatformType,
    ): Promise<any | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.minimizeComment(params);
    }

    async getRepositoryAllFiles(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: {
                id: string;
                name: string;
            };
            filters?: {
                branch?: string;
                filePatterns?: string[];
                excludePatterns?: string[];
                maxFiles?: number;
            };
            /**
             * Throw a `RepositoryListingError` instead of returning `[]` when the
             * repository cannot be listed, so a failure is not read as a
             * repository without the files.
             */
            throwOnError?: boolean;
        },
        type?: PlatformType,
    ): Promise<RepositoryFile[]> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getRepositoryAllFiles(params);
    }

    async getLanguageRepository(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string; fullName?: string };
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getLanguageRepository(params);
    }

    async mergePullRequest(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string; fullName?: string };
            prNumber: number;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.mergePullRequest(params);
    }

    async getCloneParams(
        params: {
            repository: Pick<
                Repository,
                'id' | 'defaultBranch' | 'fullName' | 'name'
            >;
            organizationAndTeamData: OrganizationAndTeamData;
        },
        type?: PlatformType,
    ): Promise<GitCloneParams> {
        ({ type, params } = await this.route(params, type));

        // Same guard the list-returning methods here already apply: with no
        // integration, getTypeIntegration answers null and the factory would
        // throw "Repository service for type 'null' not found". Callers already
        // treat a null result as "no clone params" — the adapters return null
        // on failure too.
        if (!type) {
            return null;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getCloneParams(params);
    }

    async approvePullRequest(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string; fullName?: string };
            prNumber: number;
            headSha?: string;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.approvePullRequest(params);
    }

    async requestChangesPullRequest(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string; fullName?: string };
            prNumber: number;
            criticalComments: CommentResult[];
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.requestChangesPullRequest(params);
    }

    async getAllCommentsInPullRequest(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string; fullName?: string };
            prNumber: number;
            failOnError?: boolean;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getAllCommentsInPullRequest(params);
    }

    async getUserByUsername(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            username: string;
        },
        type?: PlatformType,
    ) {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getUserByUsername(params);
    }

    async getUserByEmailOrName(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            email?: string;
            userName: string;
        },
        type?: PlatformType,
    ): Promise<any | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getUserByEmailOrName(params);
    }

    async getUserById(
        params: {
            userId: string;
            organizationAndTeamData: OrganizationAndTeamData;
        },
        type?: PlatformType,
    ): Promise<any | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getUserById(params);
    }

    async resolveMrAuthorFromWebhookPayload(
        params: {
            payload: any;
            organizationAndTeamData: OrganizationAndTeamData;
        },
        type?: PlatformType,
    ): Promise<any | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return (
            codeManagementService.resolveMrAuthorFromWebhookPayload?.(params) ??
            null
        );
    }

    async getCurrentUser(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
        },
        type?: PlatformType,
    ): Promise<any | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        if (!codeManagementService.getCurrentUser) {
            return null;
        }

        return codeManagementService.getCurrentUser(params);
    }

    async markReviewCommentAsResolved(
        params: any,
        type?: PlatformType,
    ): Promise<any | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.markReviewCommentAsResolved(params);
    }

    async getPullRequestReviewComments(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: Partial<Repository>;
            prNumber: number;
        },
        type?: PlatformType,
    ): Promise<PullRequestReviewComment[] | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getPullRequestReviewComments(params);
    }

    async getPullRequestsByRepository(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { id: string; name: string; fullName?: string };
            filters?: {
                startDate: string;
                endDate: string;
                number?: number;
                branch?: string;
                dateField?: 'created' | 'updated';
                maxResults?: number;
            };
        },
        type?: PlatformType,
    ): Promise<any[]> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getPullRequestsByRepository(params);
    }

    async getPullRequestReviewThreads(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: Partial<Repository>;
            prNumber: number;
        },
        type?: PlatformType,
    ): Promise<any | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getPullRequestReviewThreads(params);
    }

    async getAnsweredReviewThreadRootIds(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: Partial<Repository>;
            prNumber: number;
        },
        type?: PlatformType,
    ): Promise<Set<string> | null> {
        try {
            if (!type) {
                type = await this.getTypeIntegration(
                    extractOrganizationAndTeamData(params),
                );
            }
            if (!type) return null;

            const codeManagementService =
                this.platformIntegrationFactory.getCodeManagementService(type);

            if (!codeManagementService.getAnsweredReviewThreadRootIds) {
                return null;
            }

            return await codeManagementService.getAnsweredReviewThreadRootIds(
                params,
            );
        } catch (error) {
            this.logger.warn({
                message: `Could not read answered review threads for PR#${params.prNumber}`,
                context: CodeManagementService.name,
                error,
                metadata: {
                    organizationId:
                        params.organizationAndTeamData?.organizationId,
                    teamId: params.organizationAndTeamData?.teamId,
                    repositoryId: params.repository?.id,
                    prNumber: params.prNumber,
                    platformType: type,
                },
            });
            return null;
        }
    }

    async getPullRequestsWithChangesRequested(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: Partial<Repository>;
        },
        type?: PlatformType,
    ): Promise<PullRequestsWithChangesRequested[] | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getPullRequestsWithChangesRequested(
            params,
        );
    }

    async getListOfValidReviews(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: Partial<Repository>;
            prNumber: number;
        },
        type?: PlatformType,
    ): Promise<any[] | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getListOfValidReviews(params);
    }

    async checkIfPullRequestShouldBeApproved(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            prNumber: number;
            repository: { id: string; name: string; fullName?: string };
        },
        type?: PlatformType,
    ): Promise<any | null> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.checkIfPullRequestShouldBeApproved(params);
    }

    async deleteWebhook(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<void> {
        const routed = await this.route(params);
        const type = routed.type;
        params = routed.params;

        if (!type) {
            return;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.deleteWebhook(params);
    }

    async ensureRepositoryWebhooks(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repositories: Repositories[];
        },
        type?: PlatformType,
    ): Promise<WebhookSetupResult> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            throw new Error(
                'No code management integration is connected for this team',
            );
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.ensureRepositoryWebhooks(params);
    }

    async isWebhookActive(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<boolean> {
        const routed = await this.route(params);
        const type = routed.type;
        params = routed.params;

        if (!type) {
            return false;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.isWebhookActive(params);
    }

    async userCanWrite(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { id: string; name?: string; owner?: string };
            userId?: string | number;
            login?: string;
        },
        type?: PlatformType,
    ): Promise<boolean | undefined> {
        ({ type, params } = await this.route(params, type));
        if (!type) {
            return undefined;
        }
        return this.platformIntegrationFactory
            .getCodeManagementService(type)
            .userCanWrite?.(params);
    }

    async diagnoseRepositoryAccess(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string; fullName?: string };
    }): Promise<RepositoryAccessDiagnosis> {
        const routed = await this.route(params);
        const type = routed.type;
        params = routed.params;

        if (!type) {
            return { ...UNKNOWN_REPOSITORY_ACCESS };
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        if (!codeManagementService.diagnoseRepositoryAccess) {
            return { ...UNKNOWN_REPOSITORY_ACCESS };
        }

        return codeManagementService.diagnoseRepositoryAccess(params);
    }

    async formatReviewCommentBody(
        params: {
            suggestion: any;
            repository: { name: string; language: string };
            includeHeader?: boolean;
            includeFooter?: boolean;
            language?: string;
            organizationAndTeamData: OrganizationAndTeamData;
            suggestionCopyPrompt?: boolean;
        },
        type?: PlatformType,
    ): Promise<string> {
        ({ type, params } = await this.route(params, type));

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.formatReviewCommentBody({
            suggestion: params.suggestion,
            repository: params.repository,
            includeHeader: params.includeHeader ?? true,
            includeFooter: params.includeFooter ?? true,
            language: params.language,
            organizationAndTeamData: params.organizationAndTeamData,
            suggestionCopyPrompt: params.suggestionCopyPrompt,
        });
    }

    async getRepositoryTree(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repositoryId: string;
        },
        type?: PlatformType,
    ): Promise<TreeItem[]> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return [];
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getRepositoryTree(params);
    }

    async getRepositoryTreeByDirectory(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repositoryId: string;
            directoryPath?: string;
        },
        type?: PlatformType,
    ): Promise<TreeItem[]> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return [];
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getRepositoryTreeByDirectory(params);
    }

    async updateResponseToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        parentId: string;
        commentId: string;
        body: string;
        repository: { id: string; name: string; fullName?: string };
        prNumber: number;
    }): Promise<any | null> {
        const routed = await this.route(params);
        const type = routed.type;
        params = routed.params;

        if (!type) {
            return null;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.updateResponseToComment(params);
    }

    async isDraftPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
    }): Promise<boolean> {
        const routed = await this.route(params);
        const type = routed.type;
        params = routed.params;

        if (!type) {
            return false;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.isDraftPullRequest(params);
    }

    async getReviewStatusByPullRequest(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: Partial<Repository>;
            prNumber: number;
        },
        type?: PlatformType,
    ): Promise<PullRequestReviewState | null> {
        ({ type, params } = await this.route(params, type));

        if (!type) {
            return null;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.getReviewStatusByPullRequest(params);
    }

    async dismissOwnPullRequestApprovals(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
        reason: string;
    }): Promise<number> {
        const routed = await this.route(params);
        const type = routed.type;
        params = routed.params;
        const provider =
            this.platformIntegrationFactory.getCodeManagementService(type);
        // Every host implements it; one that does not must fail the step
        // rather than leave Kody's approval in place under a hold.
        if (!provider?.dismissOwnPullRequestApprovals) {
            throw new Error(`Approval dismissal is unavailable on ${type}`);
        }
        return provider.dismissOwnPullRequestApprovals(params);
    }

    async isOwnAccount(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            account: HostAccount;
        },
        type?: PlatformType,
    ): Promise<boolean> {
        ({ type, params } = await this.route(params, type));
        const provider =
            this.platformIntegrationFactory.getCodeManagementService(type);
        // A host that cannot tell is never taken for Kody.
        return (await provider?.isOwnAccount?.(params)) ?? false;
    }

    async dismissOwnPullRequestChangeRequests(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: Partial<Repository>;
            prNumber: number;
            reason: string;
        },
        type?: PlatformType,
    ): Promise<number> {
        ({ type, params } = await this.route(params, type));
        const provider =
            this.platformIntegrationFactory.getCodeManagementService(type);
        // A host that can show Kody's change request must be able to take it
        // back; failing here keeps a silent no-op from looking like success.
        if (!provider?.dismissOwnPullRequestChangeRequests) {
            throw new Error(
                `Change request withdrawal is unavailable on ${type}`,
            );
        }
        return provider.dismissOwnPullRequestChangeRequests(params);
    }

    async addReactionToPR(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reaction: Reaction;
    }): Promise<void> {
        const routed = await this.route(params);
        const type = routed.type;
        params = routed.params;

        if (!type) {
            return;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.addReactionToPR?.(params);
    }

    async addReactionToComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        commentId: number;
        reaction: Reaction;
    }): Promise<void> {
        const routed = await this.route(params);
        const type = routed.type;
        params = routed.params;

        if (!type) {
            return;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.addReactionToComment?.(params);
    }

    async removeReactionsFromPR(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        reactions: Reaction[];
    }): Promise<void> {
        const routed = await this.route(params);
        const type = routed.type;
        params = routed.params;

        if (!type) {
            return;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.removeReactionsFromPR?.(params);
    }

    async removeReactionsFromComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id?: string; name?: string };
        prNumber: number;
        commentId: number;
        reactions: Reaction[];
    }): Promise<void> {
        const routed = await this.route(params);
        const type = routed.type;
        params = routed.params;

        if (!type) {
            return;
        }

        const codeManagementService =
            this.platformIntegrationFactory.getCodeManagementService(type);

        return codeManagementService.removeReactionsFromComment?.(params);
    }
}

/** The repository a call is about, as far as its params tell. */
function repositoryHint(params: unknown): ConnectionRepositoryHint | undefined {
    if (!params || typeof params !== 'object') return undefined;
    const p = params as {
        repository?: {
            id?: string | number;
            name?: string;
            fullName?: string;
            full_name?: string;
        };
        repositoryId?: string | number;
    };
    if (p.repository && typeof p.repository === 'object') {
        const { id, name } = p.repository;
        const fullName = p.repository.fullName ?? p.repository.full_name;
        if (id == null && !name && !fullName) return undefined;
        return { id, name, fullName };
    }
    if (p.repositoryId != null) return { id: p.repositoryId };
    return undefined;
}
