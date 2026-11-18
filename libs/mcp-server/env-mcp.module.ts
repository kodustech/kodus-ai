import { forwardRef, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { TeamModule } from '@libs/organization/modules/team.module';
import { RuntimeApiModule } from '@libs/runtime/api/runtime-api.module';

import { McpAuthModule } from './auth/mcp-auth.module';
import { EnvMcpController } from './controllers/env-mcp.controller';
import { McpEnabledGuard } from './guards/mcp-enabled.guard';
import { McpEnvTeamKeyGuard } from './guards/mcp-env-team-key.guard';
import { EnvMcpServerService } from './services/env-mcp-server.service';
import { EnvTools } from './tools/env.tools';

/** /mcp/env (Inc. 1): the env_* tools over RuntimeEnvToolsService. */
@Module({
    // @UseGuards(McpAuthGuard) is instantiated here, so its dependencies must be visible here.
    imports: [
        McpAuthModule,
        JwtModule,
        forwardRef(() => TeamModule),
        forwardRef(() => RuntimeApiModule),
    ],
    controllers: [EnvMcpController],
    providers: [
        EnvMcpServerService,
        EnvTools,
        McpEnabledGuard,
        McpEnvTeamKeyGuard,
    ],
})
export class EnvMcpModule {}
