import { DynamicModule, Module, Provider, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PlatformCoreModule } from '@libs/platform/modules/platform-core.module';

import { KodusIssuesMcpController } from './controllers/kodus-issues-mcp.controller';
import { McpEnabledGuard } from './guards/mcp-enabled.guard';
import { McpCoreModule } from './mcp-core.module';
import { KodusIssuesMcpServerFactory } from './services/kodus-issues-mcp-server.factory';
import { KodusIssuesMcpServerService } from './services/kodus-issues-mcp-server.service';
import { KodusIssuesTools } from './tools/kodusIssues.tools';

@Module({})
export class KodusIssuesMcpModule {
    static forRoot(configService?: ConfigService): DynamicModule {
        const imports: any[] = [McpCoreModule];
        const providers: Provider[] = [];
        const controllers = [];
        const exports: Provider[] = [McpCoreModule];

        imports.push(forwardRef(() => PlatformCoreModule));

        controllers.push(KodusIssuesMcpController);

        providers.push(
            KodusIssuesMcpServerFactory,
            KodusIssuesMcpServerService,
            McpEnabledGuard,
            KodusIssuesTools,
        );

        exports.push(KodusIssuesMcpServerService);

        return {
            module: KodusIssuesMcpModule,
            imports,
            controllers,
            providers,
            exports,
            global: true,
        };
    }
}
