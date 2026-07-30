import { Inject, Injectable } from '@nestjs/common';

import { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { PlatformType } from '@libs/core/domain/enums';
import {
    CodeSuggestion,
    Comment,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import { IntegrationServiceDecorator } from '@libs/common/utils/decorators/integration-service.decorator';
import {
    DRY_RUN_SERVICE_TOKEN,
    IDryRunService,
} from '@libs/dryRun/domain/contracts/dryRun.service.contract';
import { ICodeManagementService } from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';

type PartialICodeManagementService = Pick<
    ICodeManagementService,
    | 'createIssueComment'
    | 'formatReviewCommentBody'
    | 'createReviewComment'
    | 'updateDescriptionInPullRequest'
    | 'updateIssueComment'
    | 'minimizeComment'
>;

@Injectable()
@IntegrationServiceDecorator(PlatformType.INTERNAL, 'codeManagement')
export class InternalCodeManagementService implements PartialICodeManagementService {
    private readonly logger = createLogger(InternalCodeManagementService.name);

    constructor(
        @Inject(DRY_RUN_SERVICE_TOKEN)
        private readonly dryRunService: IDryRunService,
    ) {}

    minimizeComment(params: any): Promise<any | null> {
        return null;
    }

    updateIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        commentId: number;
        body: string;
        dryRun: CodeReviewPipelineContext['dryRun'];
    }): Promise<any | null> {
        const { organizationAndTeamData, commentId, body, dryRun } = params;

        try {
            const result = this.dryRunService.updateMessageInDryRun({
                organizationAndTeamData,
                id: dryRun?.id,
                commentId,
                content: body,
            });

            if (!result) {
                this.logger.warn({
                    message:
                        'Received null after trying to update issue comment in dry run',
                    context: `${InternalCodeManagementService.name}.updateIssueComment`,
                    serviceName: InternalCodeManagementService.name,
                    metadata: {
                        params,
                        result,
                    },
                });

                return null;
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error updating issue comment',
                context: `${InternalCodeManagementService.name}.updateIssueComment`,
                serviceName: InternalCodeManagementService.name,
                metadata: {
                    error,
                    params,
                },
            });

            return null;
        }
    }

    async updateDescriptionInPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        summary: string;
        dryRun: CodeReviewPipelineContext['dryRun'];
    }): Promise<any | null> {
        const { organizationAndTeamData, summary, dryRun } = params;

        try {
            const result = await this.dryRunService.updateDescriptionInDryRun({
                organizationAndTeamData,
                id: dryRun?.id,
                description: summary,
            });

            if (!result) {
                this.logger.warn({
                    message:
                        'Received null after trying to update PR description in dry run',
                    context: `${InternalCodeManagementService.name}.updateDescriptionInPullRequest`,
                    serviceName: InternalCodeManagementService.name,
                    metadata: {
                        params,
                        result,
                    },
                });

                return null;
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error updating PR description',
                context: `${InternalCodeManagementService.name}.updateDescriptionInPullRequest`,
                serviceName: InternalCodeManagementService.name,
                metadata: {
                    error,
                    params,
                },
            });

            return null;
        }
    }

    async createReviewComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        lineComment: Comment;
        dryRun: CodeReviewPipelineContext['dryRun'];
    }): Promise<any | null> {
        const { organizationAndTeamData, lineComment, dryRun } = params;

        try {
            const result = await this.dryRunService.addMessageToDryRun({
                organizationAndTeamData,
                id: dryRun?.id,
                content: await this.formatReviewCommentBody({
                    organizationAndTeamData,
                    suggestion: lineComment.suggestion,
                }),
                lines: {
                    start: lineComment.suggestion.relevantLinesStart,
                    end: lineComment.suggestion.relevantLinesEnd,
                },
                path: lineComment.path,
                category: lineComment.suggestion.label,
                severity: lineComment.suggestion.severity,
                language: lineComment.suggestion.language,
                existingCode: lineComment.suggestion.existingCode,
                improvedCode: lineComment.suggestion.improvedCode,
            });

            if (!result) {
                this.logger.warn({
                    message:
                        'Received null after trying to add review comment to dry run',
                    context: `${InternalCodeManagementService.name}.createReviewComment`,
                    serviceName: InternalCodeManagementService.name,
                    metadata: {
                        params,
                        result,
                    },
                });

                return null;
            }

            return result.messages.pop();
        } catch (error) {
            this.logger.error({
                message: 'Error creating review comment',
                error,
                metadata: params,
                context: `${InternalCodeManagementService.name}.createReviewComment`,
                serviceName: InternalCodeManagementService.name,
            });
        }
    }

    async createIssueComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        body: string;
        dryRun: CodeReviewPipelineContext['dryRun'];
        suggestion?: ISuggestionByPR;
    }): Promise<any | null> {
        const { organizationAndTeamData, body, dryRun, suggestion } = params;

        try {
            const result = await this.dryRunService.addMessageToDryRun({
                organizationAndTeamData,
                id: dryRun?.id,
                content: body,
                category: suggestion?.label,
                severity: suggestion?.severity,
            });

            if (!result) {
                this.logger.warn({
                    message:
                        'Received null after trying to add issue comment to dry run',
                    context: `${InternalCodeManagementService.name}.createIssueComment`,
                    serviceName: InternalCodeManagementService.name,
                    metadata: {
                        params,
                        result,
                    },
                });

                return null;
            }

            return result.messages.pop();
        } catch (error) {
            this.logger.error({
                message: 'Error creating issue comment',
                context: `${InternalCodeManagementService.name}.createIssueComment`,
                serviceName: InternalCodeManagementService.name,
                metadata: {
                    error,
                    params,
                },
            });

            return null;
        }
    }

    formatReviewCommentBody(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        suggestion: CodeSuggestion;
    }): Promise<string> {
        const { suggestion } = params;

        let commentBody = '';

        if (suggestion?.suggestionContent) {
            commentBody += `${suggestion.suggestionContent}\n\n`;
        }

        if (suggestion?.clusteringInformation?.actionStatement) {
            commentBody += `${suggestion.clusteringInformation.actionStatement}\n\n`;
        }

        return Promise.resolve(commentBody.trim());
    }
}
