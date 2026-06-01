import { Controller, Get } from '@nestjs/common';
import {
    ApiInternalServerErrorResponse,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ErrorResponseDto } from '../common/dto';
import { HealthResponseDto } from './dto/health-response.dto';

@ApiTags('Health')
@Controller('health')
export class HealthController {
    constructor(
        @InjectDataSource()
        private dataSource: DataSource,
    ) {}

    @Get()
    @ApiOperation({
        summary: 'Health check',
        description:
            'Returns service health, environment, and dependency status.',
    })
    @ApiOkResponse({ type: HealthResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    async getHealth() {
        let databaseStatus = 'error';

        try {
            databaseStatus = this.dataSource.isInitialized
                ? 'connected'
                : 'error';
        } catch (error) {
            databaseStatus = 'error';
        }

        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime()) + 's',
            environment: process.env.API_MCP_MANAGER_NODE_ENV || 'development',
            version: process.env.npm_package_version || '1.0.0',
            database: databaseStatus,
            memory: {
                used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                total: Math.round(
                    process.memoryUsage().heapTotal / 1024 / 1024,
                ),
            },
        };
    }
}
