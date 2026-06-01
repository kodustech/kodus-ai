import { Module, forwardRef } from '@nestjs/common';

import { AuthIntegrationModule } from '@libs/integrations/modules/authIntegration.module';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { IntegrationCoreModule } from '@libs/integrations/modules/integrations-core.module';
import { AzureReposModule } from './azure-repos.module';
import { BitbucketModule } from './bitbucket.module';
import { ForgejoModule } from './forgejo.module';
import { GithubModule } from './github.module';
import { GitlabModule } from './gitlab.module';

import { AgentsModule } from '@libs/agents/modules/agents.module';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { PullRequestMessagesModule } from '@libs/code-review/modules/pullRequestMessages.module';
import { PermissionsModule } from '@libs/identity/modules/permissions.module';
import { OrganizationParametersModule } from '@libs/organization/modules/organizationParameters.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { PlatformDataModule } from '@libs/platformData/platformData.module';
import CodeManagementUseCases from '../application/use-cases/codeManagement';
import { AzureReposPullRequestHandler } from '../infrastructure/webhooks/azure/azureReposPullRequest.handler';
import { BitbucketPullRequestHandler } from '../infrastructure/webhooks/bitbucket/bitbucketPullRequest.handler';
import { ForgejoPullRequestHandler } from '../infrastructure/webhooks/forgejo/forgejoPullRequest.handler';
import { GitHubPullRequestHandler } from '../infrastructure/webhooks/github/githubPullRequest.handler';
import { GitLabMergeRequestHandler } from '../infrastructure/webhooks/gitlab/gitlabPullRequest.handler';

import { WebhookContextService } from '../application/services/webhook-context.service';
import { GetConnectionsUseCase } from '../application/use-cases/integrations/get-connections.use-case';
import { GetOrganizationLanguageUseCase } from '../application/use-cases/organization/get-organization-language.use-case';
import { PlatformCoreModule } from './platform-core.module';

import { AutomationModule } from '@libs/automation/modules/automation.module';
import { CodeReviewConfigurationModule } from '@libs/code-review/modules/code-review-configuration.module';
import { WorkflowModule } from '@libs/core/workflow/modules/workflow.module';
import { IssuesModule } from '@libs/issues/issues.module';
import { KodyRulesModule } from '@libs/kodyRules/modules/kodyRules.module';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';
import { SandboxModule } from '@libs/sandbox/modules/sandbox.module';

@Module({
    imports: [
        PlatformCoreModule,
        forwardRef(() => IntegrationCoreModule),
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => AuthIntegrationModule),
        GithubModule,
        GitlabModule,
        BitbucketModule,
        AzureReposModule,
        ForgejoModule,
        forwardRef(() => AgentsModule),
        forwardRef(() => OrganizationParametersModule),
        forwardRef(() => TeamModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => PlatformDataModule),
        PermissionsModule,
        forwardRef(() => PullRequestMessagesModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => AutomationModule),
        WorkflowModule.register({ type: 'webhook' }),
        forwardRef(() => KodyRulesModule),
        forwardRef(() => IssuesModule),
        forwardRef(() => McpCoreModule),
        forwardRef(() => CodeReviewConfigurationModule),
        forwardRef(() => SandboxModule),
    ],
    providers: [
        ...CodeManagementUseCases,
        GetConnectionsUseCase,
        GetOrganizationLanguageUseCase,
        WebhookContextService,
        AzureReposPullRequestHandler,
        GitHubPullRequestHandler,
        GitLabMergeRequestHandler,
        BitbucketPullRequestHandler,
        ForgejoPullRequestHandler,
        {
            provide: 'AZURE_REPOS_WEBHOOK_HANDLER',
            useExisting: AzureReposPullRequestHandler,
        },
        {
            provide: 'GITHUB_WEBHOOK_HANDLER',
            useExisting: GitHubPullRequestHandler,
        },
        {
            provide: 'GITLAB_WEBHOOK_HANDLER',
            useExisting: GitLabMergeRequestHandler,
        },
        {
            provide: 'BITBUCKET_WEBHOOK_HANDLER',
            useExisting: BitbucketPullRequestHandler,
        },
        {
            provide: 'FORGEJO_WEBHOOK_HANDLER',
            useExisting: ForgejoPullRequestHandler,
        },
    ],
    exports: [
        PlatformCoreModule,
        ...CodeManagementUseCases,
        GetConnectionsUseCase,
        GetOrganizationLanguageUseCase,
        WebhookContextService,
        'AZURE_REPOS_WEBHOOK_HANDLER',
        'GITHUB_WEBHOOK_HANDLER',
        'GITLAB_WEBHOOK_HANDLER',
        'BITBUCKET_WEBHOOK_HANDLER',
        'FORGEJO_WEBHOOK_HANDLER',
    ],
})
export class PlatformModule {}
