import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    CODE_REVIEW_FEEDBACK_SERVICE_TOKEN,
    ICodeReviewFeedbackService,
} from '@libs/code-review/domain/codeReviewFeedback/contracts/codeReviewFeedback.service.contract';
import { KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/KodyIssuesManagement.contract';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIssuesService,
    ISSUES_SERVICE_TOKEN,
} from '@libs/issues/domain/contracts/issues.service.contract';

import { IssuesEntity } from '@libs/issues/domain/entities/issues.entity';
import { IIssueDetails } from '@libs/issues/domain/interfaces/kodyIssuesManagement.interface';
import { KodyIssuesManagementService } from '@libs/issues/infrastructure/adapters/service/kodyIssuesManagement.service';

@Injectable()
export class GetIssueByIdUseCase implements IUseCase {
    constructor(
        @Inject(ISSUES_SERVICE_TOKEN)
        private readonly issuesService: IIssuesService,

        @Inject(CODE_REVIEW_FEEDBACK_SERVICE_TOKEN)
        private readonly codeReviewFeedbackService: ICodeReviewFeedbackService,

        @Inject(KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN)
        private readonly kodyIssuesManagementService: KodyIssuesManagementService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: {
                uuid: string;
                organization: { uuid: string };
            };
        },

        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(id: string): Promise<IIssueDetails | null> {
        const issue = await this.issuesService.findById(id);

        if (!issue || !issue.repository?.id) {
            return null;
        }

        await this.authorizationService.ensure({
            user: this.request.user,
            action: Action.Read,
            resource: ResourceType.Issues,
            repoIds: [issue.repository.id],
        });

        const codeReviewFeedback =
            await this.codeReviewFeedbackService.getByOrganizationId(
                issue.organizationId,
            );

        const reactions = await this.calculateTotalReactions(
            issue,
            codeReviewFeedback,
        );

        let httpUrl = issue.repository.url ?? null;

        if (issue.repository.platform === PlatformType.AZURE_REPOS) {
            const integrationConfig =
                await this.integrationConfigService.findOne({
                    configKey: IntegrationConfigKey.REPOSITORIES,
                    configValue: [{ id: issue.repository.id }],
                });

            const repoConfig = integrationConfig?.configValue?.find(
                (x) => x.id === issue.repository.id,
            );

            httpUrl = repoConfig?.http_url ?? null;
        }

        const dataToBuildUrls = {
            platform: issue.repository.platform,
            repositoryName: issue.repository.name,
            repositoryFullName: issue.repository.full_name,
            httpUrl: httpUrl,
            repositoryUrl: issue.repository.url ?? null,
        };

        const prUrls = await this.selectAllPrNumbers(issue, dataToBuildUrls);

        const enrichedContributingSuggestions =
            await this.kodyIssuesManagementService.enrichContributingSuggestions(
                issue.contributingSuggestions,
                issue.organizationId,
            );

        return {
            id: issue.uuid,
            title: issue.title,
            description: issue.description,
            age: await this.kodyIssuesManagementService.ageCalculation(issue),
            label: issue.label,
            severity: issue.severity,
            status: issue.status,
            contributingSuggestions: enrichedContributingSuggestions.map(
                (suggestion) => ({
                    id: suggestion.id,
                    prNumber: suggestion.prNumber,
                    prAuthor: suggestion.prAuthor,
                    language: suggestion.language,
                    existingCode: suggestion.existingCode,
                    improvedCode: suggestion.improvedCode,
                }),
            ),
            fileLink: {
                label: issue.filePath,
                url: this.buildFileUrl(dataToBuildUrls, issue.filePath),
            },
            prLinks: prUrls.map((pr) => ({
                label: pr.number,
                url: pr.url,
            })),
            repositoryLink: {
                label: issue.repository.name,
                url: this.buildRepositoryUrl(dataToBuildUrls),
            },
            language: issue.language,
            reactions,
            gitOrganizationName: issue.repository.full_name.split('/')[0],
            repository: {
                id: issue.repository.id,
                name: issue.repository.name,
            },
        };
    }

    //#region Auxiliary functions
    private async calculateTotalReactions(
        issue: IssuesEntity,
        codeReviewFeedback: any[],
    ): Promise<{ thumbsUp: number; thumbsDown: number }> {
        if (!codeReviewFeedback?.length) {
            return { thumbsUp: 0, thumbsDown: 0 };
        }

        const suggestionIds = new Set<string>();

        if (issue.contributingSuggestions?.length) {
            issue.contributingSuggestions.forEach((suggestion) => {
                if (suggestion.id) {
                    suggestionIds.add(suggestion.id);
                }
            });
        }

        const allRelevantFeedbacks = codeReviewFeedback?.filter(
            (feedback) =>
                feedback?.suggestionId &&
                suggestionIds.has(feedback.suggestionId),
        );

        let totalThumbsUp = 0;
        let totalThumbsDown = 0;

        allRelevantFeedbacks.forEach((feedback) => {
            if (feedback.reactions) {
                if (typeof feedback.reactions.thumbsUp === 'number') {
                    totalThumbsUp += feedback.reactions.thumbsUp;
                }
                if (typeof feedback.reactions.thumbsDown === 'number') {
                    totalThumbsDown += feedback.reactions.thumbsDown;
                }
            }
        });

        return {
            thumbsUp: totalThumbsUp,
            thumbsDown: totalThumbsDown,
        };
    }

    private async selectAllPrNumbers(
        issue: IssuesEntity,
        dataToBuildUrls: {
            platform: PlatformType;
            repositoryName: string;
            repositoryFullName: string;
            httpUrl: string;
            repositoryUrl?: string;
        },
    ): Promise<
        {
            number: string;
            url: string;
        }[]
    > {
        const prNumbers = new Set<string>();

        if (issue.contributingSuggestions?.length) {
            issue.contributingSuggestions.forEach((suggestion) => {
                if (suggestion.prNumber) {
                    prNumbers.add(suggestion.prNumber.toString());
                }
            });
        }

        const repositoryUrl = this.buildRepositoryUrl(dataToBuildUrls);

        issue.repository.url = repositoryUrl;

        const orderedPrNumbers = Array.from(prNumbers).sort(
            (a, b) => parseInt(a) - parseInt(b),
        );

        return orderedPrNumbers.map((prNumber) => ({
            number: prNumber,
            url: this.buildPullRequestUrl(dataToBuildUrls, prNumber),
        }));
    }

    //#endregion

    //#region Build URLs
    private buildFileUrl(
        data: {
            platform: PlatformType;
            repositoryName: string;
            repositoryFullName: string;
            httpUrl: string;
            repositoryUrl?: string;
        },
        filePath: string,
        branch: string = 'main',
    ): string {
        const cleanFilePath = filePath.startsWith('/')
            ? filePath.substring(1)
            : filePath;

        const repositoryUrl = this.buildRepositoryUrl(data);

        switch (data.platform) {
            case PlatformType.GITHUB:
                return `${repositoryUrl}/blob/${branch}/${cleanFilePath}`;
            case PlatformType.GITLAB:
                return `${repositoryUrl}/-/blob/${branch}/${cleanFilePath}`;
            case PlatformType.AZURE_REPOS:
                return `${data.httpUrl}?path=/${cleanFilePath}`;
            case PlatformType.BITBUCKET:
                return `https://bitbucket.org/${data.repositoryFullName}/src/${branch}/${cleanFilePath}`;
            default:
                throw new Error(`Platform not supported: ${data.platform}`);
        }
    }

    private buildPullRequestUrl(
        data: {
            platform: PlatformType;
            repositoryName: string;
            repositoryFullName: string;
            httpUrl: string;
            repositoryUrl?: string;
        },
        prNumber: string,
    ): string {
        const repositoryUrl = this.buildRepositoryUrl(data);

        switch (data.platform) {
            case PlatformType.GITHUB:
                return `${repositoryUrl}/pull/${prNumber}`;
            case PlatformType.GITLAB:
                return `${repositoryUrl}/-/merge_requests/${prNumber}`;
            case PlatformType.AZURE_REPOS:
                return `${data.httpUrl}/pullrequest/${prNumber}`;
            case PlatformType.BITBUCKET:
                return `https://bitbucket.org/${data.repositoryFullName}/pull-requests/${prNumber}`;
            default:
                throw new Error(`Platform not supported: ${data.platform}`);
        }
    }

    private buildRepositoryUrl(data: {
        platform: PlatformType;
        repositoryFullName: string;
        httpUrl: string;
        repositoryUrl?: string;
    }): string {
        switch (data.platform) {
            case PlatformType.GITHUB:
                if (data.repositoryUrl) {
                    try {
                        const parsedRepositoryUrl = new URL(data.repositoryUrl);
                        return `${parsedRepositoryUrl.origin}/${data.repositoryFullName}`;
                    } catch {
                        // Fall back to cloud URL when stored repository URL is malformed.
                    }
                }

                return `https://github.com/${data.repositoryFullName}`;
            case PlatformType.GITLAB: {
                const gitlabUrl = process.env.WEB_GITLAB_OAUTH_URL
                    ? new URL(process.env.WEB_GITLAB_OAUTH_URL).origin
                    : 'https://gitlab.com';
                return `${gitlabUrl}/${data.repositoryFullName}`;
            }
            case PlatformType.AZURE_REPOS:
                return data.httpUrl;
            case PlatformType.BITBUCKET:
                return `https://bitbucket.org/${data.repositoryFullName}`;
            default:
                throw new Error(`Platform not supported: ${data.platform}`);
        }
    }
    //#endregion
}
