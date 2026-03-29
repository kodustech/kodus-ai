import { createLogger } from '@kodus/flow';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { IGithubIssuesService } from '@libs/platform/domain/github/contracts/github-issues.service.contract';
import {
    GetGitHubIssueParams,
    GitHubIssue,
    ListGitHubIssuesParams,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/issues.type';
import { GithubService } from './github.service';

@Injectable()
export class GithubIssuesService implements IGithubIssuesService {
    private readonly logger = createLogger(GithubIssuesService.name);

    constructor(
        private readonly githubService: GithubService,
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
    ) {}

    async listIssues(params: ListGitHubIssuesParams): Promise<GitHubIssue[]> {
        const { organizationAndTeamData, repository, filters = {} } = params;

        const page = Math.max(1, filters.page ?? 1);
        const perPage = Math.min(Math.max(1, filters.perPage ?? 30), 100);

        try {
            await this.ensureValidGithubIntegration(organizationAndTeamData);

            const octokit = await this.githubService.getAuthenticatedOctokit(
                organizationAndTeamData,
            );

            const response = await octokit.rest.issues.listForRepo({
                owner: repository.owner,
                repo: repository.name,
                state: filters.state,
                labels: filters.labels?.join(','),
                assignee: filters.assignee,
                creator: filters.creator,
                since: filters.since,
                sort: filters.sort,
                direction: filters.direction,
                page,
                per_page: perPage,
            });

            // GitHub returns pull requests in the issues list; keep only repository issues.
            return response.data
                .filter((item) => !item.pull_request)
                .map((item) => this.mapIssue(item));
        } catch (error) {
            this.logger.error({
                message: 'Failed to list GitHub issues',
                context: GithubIssuesService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    repository,
                    filters,
                },
            });

            throw error;
        }
    }

    async getIssue(params: GetGitHubIssueParams): Promise<GitHubIssue | null> {
        const { organizationAndTeamData, repository, issueNumber } = params;

        try {
            await this.ensureValidGithubIntegration(organizationAndTeamData);

            const octokit = await this.githubService.getAuthenticatedOctokit(
                organizationAndTeamData,
            );

            const response = await octokit.rest.issues.get({
                owner: repository.owner,
                repo: repository.name,
                issue_number: issueNumber,
            });

            if ((response.data as any).pull_request) {
                return null;
            }

            return this.mapIssue(response.data);
        } catch (error: any) {
            if (error?.status === 404) {
                return null;
            }

            this.logger.error({
                message: 'Failed to get GitHub issue',
                context: GithubIssuesService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    repository,
                    issueNumber,
                },
            });

            throw error;
        }
    }

    private async ensureValidGithubIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        if (
            !organizationAndTeamData?.organizationId ||
            !organizationAndTeamData?.teamId
        ) {
            throw new BadRequestException(
                'Organization ID and Team ID are required',
            );
        }

        const integration = await this.integrationService.findOne({
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            platform: PlatformType.GITHUB,
            status: true,
        });

        if (!integration) {
            throw new BadRequestException(
                'A valid GitHub integration is required for this organization/team',
            );
        }
    }

    private mapIssue(item: any): GitHubIssue {
        const labels = (item.labels ?? [])
            .map((label: any) => label?.name)
            .filter((name: unknown): name is string => !!name);
        const assignees = (item.assignees ?? [])
            .map((assignee: any) => assignee?.login)
            .filter((login: unknown): login is string => !!login);

        return {
            id: item.id,
            nodeId: item.node_id,
            number: item.number,
            title: item.title,
            body: item.body,
            state: item.state,
            locked: item.locked,
            htmlUrl: item.html_url,
            comments: item.comments,
            labels,
            assignees,
            user: item.user
                ? {
                      login: item.user.login,
                      id: item.user.id,
                      avatarUrl: item.user.avatar_url,
                      htmlUrl: item.user.html_url,
                  }
                : null,
            createdAt: item.created_at,
            updatedAt: item.updated_at,
            closedAt: item.closed_at,
        };
    }
}
