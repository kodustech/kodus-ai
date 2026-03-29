import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Controller, Get, HttpStatus, Optional, Res } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Response } from 'express';
import { DataSource } from 'typeorm';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';

/**
 * WebhookHealthController - Simplified Health Check for Webhook Handler
 *
 * Verifies only the essentials:
 * - Application status
 * - RabbitMQ connection (critical - needed to enqueue messages)
 * - PostgreSQL connection (critical - needed to save webhook logs)
 */
@Public()
@Controller('health')
export class WebhookHealthController {
    constructor(
        @InjectDataSource()
        private readonly dataSource: DataSource,
        @Optional()
        private readonly amqpConnection: AmqpConnection,
    ) {}

    @Get()
    async check(@Res() res: Response) {
        try {
            const checks = {
                application: await this.checkApplication(),
                rabbitmq: await this.checkRabbitMQ(),
                postgresql: await this.checkPostgreSQL(),
            };

            const allHealthy = Object.values(checks).every(
                (check) => check.status === 'ok' || check.status === 'skipped',
            );

            const response = {
                status: allHealthy ? 'ok' : 'degraded',
                version: process.env.RELEASE_VERSION || 'unknown',
                timestamp: new Date().toISOString(),
                checks,
            };

            const statusCode = allHealthy
                ? HttpStatus.OK
                : HttpStatus.SERVICE_UNAVAILABLE;

            return res.status(statusCode).json(response);
        } catch (error) {
            const response = {
                status: 'error',
                version: process.env.RELEASE_VERSION || 'unknown',
                error: `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
                timestamp: new Date().toISOString(),
            };

            return res.status(HttpStatus.SERVICE_UNAVAILABLE).json(response);
        }
    }

    @Get('simple')
    simpleCheck(@Res() res: Response) {
        return res.status(HttpStatus.OK).json({
            status: 'ok',
            version: process.env.RELEASE_VERSION || 'unknown',
            timestamp: new Date().toISOString(),
            message: 'Webhook handler is running',
            uptime: Math.floor(process.uptime()),
        });
    }

    @Get('ready')
    readyCheck(@Res() res: Response) {
        return this.check(res);
    }

    @Get('live')
    liveCheck(@Res() res: Response) {
        return this.simpleCheck(res);
    }

    private async checkApplication(): Promise<{
        status: string;
        error?: string;
    }> {
        try {
            return { status: 'ok' };
        } catch (error) {
            return { status: 'error', error: error.message };
        }
    }

    private async checkRabbitMQ(): Promise<{
        status: string;
        error?: string;
        message?: string;
    }> {
        try {
            const rabbitEnabled = process.env.API_RABBITMQ_ENABLED !== 'false';
            if (!rabbitEnabled) {
                return {
                    status: 'skipped',
                    message: 'RabbitMQ disabled',
                };
            }
            if (!this.amqpConnection) {
                return {
                    status: 'error',
                    error: 'RabbitMQ connection not available (disabled?)',
                };
            }

            // Verify if RabbitMQ connection is active
            const channel = this.amqpConnection.channel;
            if (!channel) {
                return {
                    status: 'error',
                    error: 'RabbitMQ channel not available',
                };
            }

            // Try to verify a queue (non-blocking if it doesn't exist)
            await channel.checkQueue('workflow.webhooks.queue').catch(() => {
                // Queue might not exist yet, but connection is OK
            });

            return { status: 'ok' };
        } catch (error) {
            return { status: 'error', error: error.message };
        }
    }

    private async checkPostgreSQL(): Promise<{
        status: string;
        error?: string;
    }> {
        try {
            // Verify if PostgreSQL connection is active
            await this.dataSource.query('SELECT 1');
            return { status: 'ok' };
        } catch (error) {
            return { status: 'error', error: error.message };
        }
    }
}
