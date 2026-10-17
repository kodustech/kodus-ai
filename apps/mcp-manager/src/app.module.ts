import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { AppConfigModule } from './config/config.module';
import { McpModule } from './modules/mcp/mcp.module';
import { getTypeOrmConfig } from './config/typeorm.config';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { HealthController } from './health/health.controller';

@Module({
    imports: [
        AppConfigModule,
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            useFactory: getTypeOrmConfig,
            inject: [ConfigService],
        }),
        JwtModule.register({
            global: true,
            // Verify tokens with the orchestrator's JWT secret — that is the
            // key the access tokens the web app forwards here are signed with
            // (the legacy API_MCP_MANAGER_JWT_SECRET was never wired to a
            // signer and shipped empty). The AuthGuard now verifies, not just
            // decodes, so this secret must be present.
            secret: process.env.API_JWT_SECRET,
        }),
        McpModule,
    ],
    controllers: [HealthController],
    providers: [
        {
            provide: APP_FILTER,
            useClass: HttpExceptionFilter,
        },
    ],
})
export class AppModule {}
