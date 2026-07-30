import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { IntegrationServiceDecorator } from '@libs/common/utils/decorators/integration-service.decorator';
import { IntegrationConfigKey, PlatformType } from '@libs/core/domain/enums';
import { ICodeManagementService } from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';

import { BitbucketCloudService } from './bitbucket/bitbucket-cloud.service';
import { BitbucketDataCenterService } from './bitbucket/bitbucket-data-center.service';
import { BitbucketAuthDetail } from '@libs/integrations/domain/authIntegrations/types/bitbucket-auth-detail.type';
import { createLogger } from '@libs/core/log/logger';
import {
    INTEGRATION_CONFIG_SERVICE_TOKEN,
    IIntegrationConfigService,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigEntity } from '@libs/integrations/domain/integrationConfigs/entities/integration-config.entity';
import { ReactionsInComments } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import {
    CodeManagementIssue,
    GetIssueParams,
    ListIssuesParams,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/issues.type';

@Injectable()
@IntegrationServiceDecorator(PlatformType.BITBUCKET, 'codeManagement')
export class BitbucketService implements Omit<
    ICodeManagementService,
    | 'getOrganizations'
    | 'getListOfValidReviews'
    | 'getUserByEmailOrName'
    | 'getPullRequestReviewThreads'
    | 'getUserById'
    | 'getDataForCalculateDeployFrequency'
    | 'getCommitsByReleaseMode'
    | 'getAuthenticationOAuthToken'
> {
    private readonly logger = createLogger(BitbucketService.name);

    constructor(
        private readonly bitbucketCloudService: BitbucketCloudService,
        private readonly bitbucketDataCenterService: BitbucketDataCenterService,

        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
    ) {}

    private async getImplementation(
        organizationAndTeamData?: OrganizationAndTeamData,
    ): Promise<any> {
        if (!organizationAndTeamData) {
            return this.bitbucketCloudService;
        }

        try {
            const authDetails =
                await this.integrationService.getPlatformAuthDetails<BitbucketAuthDetail>(
                    organizationAndTeamData,
                    PlatformType.BITBUCKET,
                );

            const host = authDetails?.host?.trim();

            if (host) {
                return this.bitbucketDataCenterService;
            }

            return this.bitbucketCloudService;
        } catch (error) {
            return this.bitbucketCloudService;
        }
    }

    async listIssues(
        params: ListIssuesParams,
    ): Promise<CodeManagementIssue[]> {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.listIssues(params);
    }

    async getIssue(
        params: GetIssueParams,
    ): Promise<CodeManagementIssue | null> {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getIssue(params);
    }

    // Bitbucket Cloud has an issue tracker; Data Center / Server does not.
    async supportsIssues(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<boolean> {
        const impl = await this.getImplementation(organizationAndTeamData);
        return impl === this.bitbucketCloudService;
    }

    // =====================================================================
    // DIRECT IMPLEMENTATIONS (Pure logic, DB queries, or Stubs)
    // =====================================================================

    async findTeamAndOrganizationIdByConfigKey(
        params: any,
    ): Promise<IntegrationConfigEntity | null> {
        try {
            const integrationConfig =
                await this.integrationConfigService.findOne({
                    configKey: IntegrationConfigKey.REPOSITORIES,
                    configValue: [{ id: params?.repository?.id?.toString() }],
                });

            return integrationConfig &&
                integrationConfig?.configValue?.length > 0
                ? integrationConfig
                : null;
        } catch (err) {
            this.logger.error({
                message: 'Error to find team and organization id by config key',
                context: BitbucketService.name,
                serviceName:
                    'BitbucketService findTeamAndOrganizationIdByConfigKey',
                error: err,
                metadata: { params },
            });
            throw new BadRequestException(err);
        }
    }

    async countReactions(params: { comments: any[]; pr: any }): Promise<any[]> {
        try {
            const { comments, pr } = params;
            const thumbsUpText = '👍';
            const thumbsDownText = '👎';

            const commentsWithNumberOfReactions = comments
                .filter(
                    (comment: any) =>
                        comment.replies && comment.replies.length > 0,
                )
                .map((comment: any) => {
                    comment.totalReactions = 0;
                    comment.thumbsUp = 0;
                    comment.thumbsDown = 0;

                    const userReactions = new Map();

                    comment.replies.forEach((reply: any) => {
                        const userId = reply.user.uuid;
                        const replyBody = reply.content.raw;

                        if (!userReactions.has(userId)) {
                            userReactions.set(userId, {
                                thumbsUp: false,
                                thumbsDown: false,
                            });
                        }

                        const userReaction = userReactions.get(userId);

                        if (
                            replyBody?.includes(thumbsUpText) &&
                            !userReaction.thumbsUp
                        ) {
                            comment.thumbsUp++;
                            userReaction.thumbsUp = true;
                        }

                        if (
                            replyBody?.includes(thumbsDownText) &&
                            !userReaction.thumbsDown
                        ) {
                            comment.thumbsDown++;
                            userReaction.thumbsDown = true;
                        }
                    });

                    comment.totalReactions =
                        comment.thumbsUp + comment.thumbsDown;
                    return comment;
                });

            const reactionsInComments: ReactionsInComments[] =
                commentsWithNumberOfReactions
                    .filter((comment) => comment.totalReactions > 0)
                    .map((comment: any) => ({
                        reactions: {
                            thumbsUp: comment.thumbsUp,
                            thumbsDown: comment.thumbsDown,
                        },
                        comment: {
                            id: comment.id,
                            body: comment.body,
                            pull_request_review_id: pr.pull_number,
                        },
                        pullRequest: {
                            id: pr.id,
                            number: pr.pull_number,
                            repository: {
                                id: pr.repository.id,
                                fullName: pr.repository.name,
                            },
                        },
                    }));

            return reactionsInComments;
        } catch (error) {
            this.logger.error({
                message: `Error when trying to count reactions in PR${params.pr.pull_number}`,
                context: BitbucketService.name,
                serviceName: 'BitbucketService countReactions',
                error: error,
                metadata: { params },
            });
            return [];
        }
    }

    formatReviewCommentBody(params: {
        suggestion: any;
        repository: { name: string; language: string };
        includeHeader?: boolean;
        includeFooter?: boolean;
        language?: string;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<string> {
        const {
            suggestion,
            repository,
            includeHeader = true,
            includeFooter = true,
        } = params;
        let commentBody = '';

        if (includeHeader) {
            const severityText = suggestion?.severity || '';
            const labelText = suggestion?.label || '';
            commentBody += `\`kody|code-review\` \`${labelText}\` \`severity-level|${severityText}\`\n\n\n`;
        }

        if (suggestion?.suggestionContent) {
            commentBody += `${suggestion.suggestionContent}\n\n`;
        }

        if (suggestion?.clusteringInformation?.actionStatement) {
            commentBody += `${suggestion.clusteringInformation.actionStatement}\n\n`;
        }

        if (suggestion?.improvedCode) {
            const lang = repository?.language?.toLowerCase() || 'javascript';
            commentBody += `\`\`\`${lang}\n${suggestion.improvedCode}\n\`\`\`\n\n`;
        }

        if (includeFooter) {
            commentBody +=
                'Was this suggestion helpful? reply with 👍 or 👎 to help Kody learn from this interaction.\n\n';
            commentBody += `\`\`\`\n👍\n\`\`\`\n\n\`\`\`\n👎\n\`\`\``;
        }

        return Promise.resolve(commentBody.trim());
    }

    // --- Not Implemented Stubs ---
    getWorkflows(params: any): Promise<any[]> {
        throw new Error('Method not implemented.');
    }
    addReactionToPR(params: any): Promise<void> {
        throw new Error('Method not implemented.');
    }
    addReactionToComment(params: any): Promise<void> {
        throw new Error('Method not implemented.');
    }
    removeReactionsFromPR(params: any): Promise<void> {
        throw new Error('Method not implemented.');
    }
    removeReactionsFromComment(params: any): Promise<void> {
        throw new Error('Method not implemented.');
    }
    minimizeComment(params: any): Promise<any | null> {
        throw new Error('Method not implemented.');
    }

    // =====================================================================
    // DELEGATED METHODS (Requires API Calls)
    // =====================================================================

    async findRepositoryByName(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.findRepositoryByName(params);
    }

    async createPullRequestWithFiles(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.createPullRequestWithFiles(params);
    }

    async uploadFiles(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.uploadFiles(params);
    }

    async getPullRequestAuthors(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getPullRequestAuthors(params);
    }

    async getPullRequestsWithChangesRequested(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getPullRequestsWithChangesRequested(params);
    }

    async getCloneParams(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getCloneParams(params);
    }

    async getPullRequests(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getPullRequests(params);
    }

    async getPullRequestsForAuthors(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getPullRequestsForAuthors(params);
    }

    async getPullRequest(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getPullRequest(params);
    }

    async getRepositories(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getRepositories(params);
    }

    async getListMembers(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getListMembers(params);
    }

    async verifyConnection(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.verifyConnection(params);
    }

    async getPullRequestsWithFiles(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getPullRequestsWithFiles(params);
    }

    async getPullRequestsForRTTM(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getPullRequestsForRTTM(params);
    }

    async getCommits(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getCommits(params);
    }

    async getFilesByPullRequestId(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getFilesByPullRequestId(params);
    }

    async getChangedFilesSinceLastCommit(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getChangedFilesSinceLastCommit(params);
    }

    async createReviewComment(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.createReviewComment(params);
    }

    async createCommentInPullRequest(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.createCommentInPullRequest(params);
    }

    async getRepositoryContentFile(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getRepositoryContentFile(params);
    }

    async getPullRequestByNumber(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getPullRequestByNumber(params);
    }

    async getCommitsForPullRequestForCodeReview(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getCommitsForPullRequestForCodeReview(params);
    }

    async createIssueComment(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.createIssueComment(params);
    }

    async createSingleIssueComment(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.createSingleIssueComment(params);
    }

    async updateIssueComment(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.updateIssueComment(params);
    }

    async markReviewCommentAsResolved(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.markReviewCommentAsResolved(params);
    }

    async getDefaultBranch(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getDefaultBranch(params);
    }

    async getPullRequestReviewComment(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getPullRequestReviewComment(params);
    }

    async createResponseToComment(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.createResponseToComment(params);
    }

    async updateDescriptionInPullRequest(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.updateDescriptionInPullRequest(params);
    }

    async getLanguageRepository(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getLanguageRepository(params);
    }

    async createAuthIntegration(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.createAuthIntegration(params);
    }

    async updateAuthIntegration(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.updateAuthIntegration(params);
    }

    async createOrUpdateIntegrationConfig(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.createOrUpdateIntegrationConfig(params);
    }

    async createWebhook(organizationAndTeamData: OrganizationAndTeamData) {
        const impl = await this.getImplementation(organizationAndTeamData);
        return impl.createWebhook(organizationAndTeamData);
    }

    async getAuthDetails(organizationAndTeamData: OrganizationAndTeamData) {
        const impl = await this.getImplementation(organizationAndTeamData);
        return impl.getAuthDetails(organizationAndTeamData);
    }

    async findOneByOrganizationAndTeamDataAndConfigKey(
        organizationAndTeamData: OrganizationAndTeamData,
        configKey: any,
    ) {
        const impl = await this.getImplementation(organizationAndTeamData);
        return impl.findOneByOrganizationAndTeamDataAndConfigKey(
            organizationAndTeamData,
            configKey,
        );
    }

    async authenticateWithToken(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.authenticateWithToken(params);
    }

    async handleIntegration(
        integration: any,
        authDetails: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const impl = await this.getImplementation(organizationAndTeamData);
        return impl.handleIntegration(
            integration,
            authDetails,
            organizationAndTeamData,
        );
    }

    async addAccessToken(
        organizationAndTeamData: OrganizationAndTeamData,
        authDetails: any,
    ) {
        const impl = await this.getImplementation(organizationAndTeamData);
        return impl.addAccessToken(organizationAndTeamData, authDetails);
    }

    async addIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
        authIntegrationId: string,
    ) {
        const impl = await this.getImplementation(organizationAndTeamData);
        return impl.addIntegration(organizationAndTeamData, authIntegrationId);
    }

    async mergePullRequest(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.mergePullRequest(params);
    }

    async getReviewStatusByPullRequest(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getReviewStatusByPullRequest(params);
    }

    async checkIfPullRequestShouldBeApproved(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.checkIfPullRequestShouldBeApproved(params);
    }

    async approvePullRequest(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.approvePullRequest(params);
    }

    async requestChangesPullRequest(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.requestChangesPullRequest(params);
    }

    async getAllCommentsInPullRequest(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getAllCommentsInPullRequest(params);
    }

    async getPullRequestsByRepository(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getPullRequestsByRepository(params);
    }

    async getUserByUsername(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getUserByUsername(params);
    }

    async getCurrentUser(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getCurrentUser(params);
    }

    async getPullRequestReviewComments(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getPullRequestReviewComments(params);
    }

    async isWebhookActive(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.isWebhookActive(params);
    }

    async deleteWebhook(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.deleteWebhook(params);
    }

    async getRepositoryTreeByDirectory(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getRepositoryTreeByDirectory(params);
    }

    async getRepositoryTree(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getRepositoryTree(params);
    }

    async getRepositoryAllFiles(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getRepositoryAllFiles(params);
    }

    async updateResponseToComment(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.updateResponseToComment(params);
    }

    async isDraftPullRequest(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.isDraftPullRequest(params);
    }

    async getRepositoryContentBatch(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getRepositoryContentBatch(params);
    }

    async getUsersByUsername(params: any) {
        const impl = await this.getImplementation(
            params.organizationAndTeamData,
        );
        return impl.getUsersByUsername(params);
    }
}
