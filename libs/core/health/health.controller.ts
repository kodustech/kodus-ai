import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { DatabaseHealthIndicator } from './database.health';
import { ApplicationHealthIndicator } from './application.health';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
    HealthCheckResponseDto,
    HealthSimpleResponseDto,
} from './health-response.dto';

@ApiTags('Health')
@Controller('health')
export class HealthController {
    constructor(
        private readonly databaseHealthIndicator: DatabaseHealthIndicator,
        private readonly applicationHealthIndicator: ApplicationHealthIndicator,
    ) {}

    @Get()
    @ApiOperation({
        summary: 'Full health check',
        description:
            'Public endpoint. Checks application and database health and returns overall status details for monitoring.',
    })
    @ApiOkResponse({ type: HealthCheckResponseDto })
    async check(@Res() res: Response) {
        try {
            // Verify application
            const appResult =
                await this.applicationHealthIndicator.isApplicationHealthy();
            const appHealthy = appResult.application.status === 'up';

            // Verify database
            const dbResult =
                await this.databaseHealthIndicator.isDatabaseHealthy();
            const dbHealthy = dbResult.database.status === 'up';

            // Both must be UP
            const overallHealthy = appHealthy && dbHealthy;

            const response = {
                status: overallHealthy ? 'ok' : 'error',
                version: process.env.RELEASE_VERSION || 'unknown',
                timestamp: new Date().toISOString(),
                details: {
                    application: appResult.application,
                    database: dbResult.database,
                },
            };

            const statusCode = overallHealthy
                ? HttpStatus.OK
                : HttpStatus.SERVICE_UNAVAILABLE;

            return res.status(statusCode).json(response);
        } catch (error) {
            const response = {
                status: 'error',
                version: process.env.RELEASE_VERSION || 'unknown',
                error: 'Health check failed: ' + error,
                timestamp: new Date().toISOString(),
            };

            return res.status(HttpStatus.SERVICE_UNAVAILABLE).json(response);
        }
    }

    @Get('ready')
    @ApiOperation({
        summary: 'Readiness check',
        description:
            'Public endpoint. Alias for the full health check used by readiness probes.',
    })
    @ApiOkResponse({ type: HealthCheckResponseDto })
    readyCheck(@Res() res: Response) {
        return this.check(res);
    }

    @Get('simple')
    @ApiOperation({
        summary: 'Simple health check',
        description:
            'Public endpoint. Lightweight response for quick liveness checks (no sensitive data).',
    })
    @ApiOkResponse({ type: HealthSimpleResponseDto })
    simpleCheck(@Res() res: Response) {
        return res.status(HttpStatus.OK).json({
            status: 'ok',
            version: process.env.RELEASE_VERSION || 'unknown',
            timestamp: new Date().toISOString(),
            message: 'API is running',
            uptime: Math.floor(process.uptime()),
        });
    }

    @Get('live')
    @ApiOperation({
        summary: 'Liveness check',
        description:
            'Public endpoint. Alias for the simple health check used by liveness probes.',
    })
    @ApiOkResponse({ type: HealthSimpleResponseDto })
    liveCheck(@Res() res: Response) {
        return this.simpleCheck(res);
    }
}
