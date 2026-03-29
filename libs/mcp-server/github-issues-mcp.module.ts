import { DynamicModule, Module, Provider, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { GithubModule } from '@libs/platform/modules/github.module';

import { GithubIssuesMcpController } from './controllers/github-issues-mcp.controller';
import { McpEnabledGuard } from './guards/mcp-enabled.guard';
import { McpCoreModule } from './mcp-core.module';
import { GithubIssuesMcpServerFactory } from './services/github-issues-mcp-server.factory';
import { GithubIssuesMcpServerService } from './services/github-issues-mcp-server.service';
import { GithubIssuesTools } from './tools/githubIssues.tools';

@Module({})
export class GithubIssuesMcpModule {
    static forRoot(configService?: ConfigService): DynamicModule {
        const imports: any[] = [McpCoreModule];
        const providers: Provider[] = [];
        const controllers = [];
        const exports: Provider[] = [McpCoreModule];

        imports.push(forwardRef(() => GithubModule));

        controllers.push(GithubIssuesMcpController);

        providers.push(
            GithubIssuesMcpServerFactory,
            GithubIssuesMcpServerService,
            McpEnabledGuard,
            GithubIssuesTools,
        );

        exports.push(GithubIssuesMcpServerService);

        return {
            module: GithubIssuesMcpModule,
            imports,
            controllers,
            providers,
            exports,
            global: true,
        };
    }
}
