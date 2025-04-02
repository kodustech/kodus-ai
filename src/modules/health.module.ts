import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from '@/core/infrastructure/http/controllers/health.controller';
import { OpenAIHealthIndicator } from '@/core/infrastructure/adapters/services/health/openai.health';
import { GitHubHealthIndicator } from '@/core/infrastructure/adapters/services/health/github.health';
import { JiraHealthIndicator } from '@/core/infrastructure/adapters/services/health/jira.health';
import { SlackHealthIndicator } from '@/core/infrastructure/adapters/services/health/slack.health';

@Module({
    imports: [TerminusModule],
    controllers: [HealthController],
    providers: [
        OpenAIHealthIndicator,
        GitHubHealthIndicator,
        JiraHealthIndicator,
        SlackHealthIndicator,
    ],
})
export class HealthModule {}
