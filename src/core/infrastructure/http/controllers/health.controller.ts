import { Controller, Get } from '@nestjs/common';
import { HealthCheckService, HealthCheck } from '@nestjs/terminus';
import { OpenAIHealthIndicator } from '@/core/infrastructure/adapters/services/health/openai.health';
import { GitHubHealthIndicator } from '@/core/infrastructure/adapters/services/health/github.health';
import { JiraHealthIndicator } from '@/core/infrastructure/adapters/services/health/jira.health';
import { SlackHealthIndicator } from '@/core/infrastructure/adapters/services/health/slack.health';

@Controller('health')
export class HealthController {
    constructor(
        private health: HealthCheckService,
        private openAIHealthIndicator: OpenAIHealthIndicator,
        private gitHubHealthIndicator: GitHubHealthIndicator,
        private jiraHealthIndicator: JiraHealthIndicator,
        private slackHealthIndicator: SlackHealthIndicator,
    ) {}

    @Get()
    @HealthCheck()
    async check() {
        const githubCheck = () => this.gitHubHealthIndicator.isGitHubHealthy();
        const openAICheck = () => this.openAIHealthIndicator.isOpenAIHealthy();
        const jiraCheck = () => this.jiraHealthIndicator.isJiraHealthy();
        const slackCheck = () => this.slackHealthIndicator.isSlackHealthy();

        return this.health.check([
            githubCheck,
            openAICheck,
            jiraCheck,
            slackCheck,
        ]);
    }
}
