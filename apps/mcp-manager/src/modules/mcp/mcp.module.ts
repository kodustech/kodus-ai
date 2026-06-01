import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { McpService } from './mcp.service';
import { McpController } from './mcp.controller';
import { ProvidersModule } from '../providers/providers.module';
import { MCPConnectionEntity } from './entities/mcp-connection.entity';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([MCPConnectionEntity]),
        ProvidersModule,
        IntegrationsModule,
    ],
    controllers: [McpController],
    providers: [McpService],
    exports: [],
})
export class McpModule {}
