import { Module, DynamicModule, Provider, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpController } from './controllers/mcp.controller';
import { McpServerService } from './services/mcp-server.service';
import { McpEnabledGuard } from './guards/mcp-enabled.guard';
import { PlatformIntegrationModule } from '../../../../modules/platformIntegration.module';
import {
    CodeManagementTools,
    KodyRulesTools,
    AutomationTools,
    CodeReviewTools,
    OrganizationTools,
    IssuesTools,
    WebhookTools,
    UsageTools,
} from './tools';
import { MCPManagerService } from './services/mcp-manager.service';
import { JwtModule } from '@nestjs/jwt';
import { KodyRulesModule } from '@/modules/kodyRules.module';
import { LicenseModule } from '@/ee/license/license.module';
import { PermissionValidationModule } from '@/ee/shared/permission-validation.module';
import { AutomationModule } from '@/modules/automation.module';
import { CodeReviewFeedbackModule } from '@/modules/codeReviewFeedback.module';
import { OrganizationModule } from '@/modules/organization.module';
import { TeamModule } from '@/modules/team.module';
import { TeamMembersModule } from '@/modules/teamMembers.module';
import { IssuesModule } from '@/modules/issues.module';
import { WebhookLogModule } from '@/modules/webhookLog.module';
import { TokenUsageModule } from '@/modules/tokenUsage.module';

@Module({})
export class McpModule {
    static forRoot(configService?: ConfigService): DynamicModule {
        const imports = [];
        const providers: Provider[] = [];
        const controllers = [];
        const exports = [];

        // Always provide MCPManagerService, controllers and full functionality are conditional
        const isEnabled =
            process.env.API_MCP_SERVER_ENABLED === 'true' ||
            configService?.get<boolean>('API_MCP_SERVER_ENABLED', false);

        // Always provide MCPManagerService for dependency injection
        providers.push(MCPManagerService);
        exports.push(MCPManagerService);

        // Always import required modules for MCPManagerService dependencies
        imports.push(JwtModule, PermissionValidationModule);

        if (isEnabled) {
            imports.push(
                forwardRef(() => PlatformIntegrationModule),
                forwardRef(() => KodyRulesModule),
                forwardRef(() => AutomationModule),
                forwardRef(() => CodeReviewFeedbackModule),
                forwardRef(() => OrganizationModule),
                forwardRef(() => TeamModule),
                forwardRef(() => TeamMembersModule),
                forwardRef(() => IssuesModule),
                forwardRef(() => WebhookLogModule),
                forwardRef(() => TokenUsageModule),
            );

            controllers.push(McpController);

            providers.push(
                McpServerService,
                McpEnabledGuard,
                CodeManagementTools,
                KodyRulesTools,
                AutomationTools,
                CodeReviewTools,
                OrganizationTools,
                IssuesTools,
                WebhookTools,
                UsageTools,
            );

            exports.push(McpServerService);
        }

        return {
            module: McpModule,
            imports,
            controllers,
            providers,
            exports,
            global: true,
        };
    }
}
