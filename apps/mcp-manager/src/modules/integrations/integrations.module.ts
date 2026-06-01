import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UtilsModule } from '../../common/utils/utils.module';
import { MCPIntegrationOAuthEntity } from './entities/mcp-integration-oauth.entity';
import { MCPIntegrationEntity } from './entities/mcp-integration.entity';
import { IntegrationOAuthService } from './integration-oauth.service';
import { IntegrationsService } from './integrations.service';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            MCPIntegrationEntity,
            MCPIntegrationOAuthEntity,
        ]),
        UtilsModule,
    ],
    providers: [IntegrationsService, IntegrationOAuthService],
    exports: [IntegrationsService, IntegrationOAuthService],
})
export class IntegrationsModule {}
