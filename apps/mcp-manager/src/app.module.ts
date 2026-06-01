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
            secret: process.env.API_MCP_MANAGER_JWT_SECRET,
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
