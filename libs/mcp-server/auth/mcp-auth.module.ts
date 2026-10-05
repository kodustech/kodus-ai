import { forwardRef, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { TeamModule } from '@libs/organization/modules/team.module';

import { McpAuthGuard } from '../guards/mcp-auth.guard';
import { McpToolAuthorizer } from './mcp-tool-authorizer.service';

@Module({
    imports: [JwtModule, forwardRef(() => TeamModule)],
    providers: [McpAuthGuard, McpToolAuthorizer],
    exports: [McpAuthGuard, McpToolAuthorizer],
})
export class McpAuthModule {}
