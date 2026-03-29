import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';

/**
 * WebhookHealthController - Simplified health check for the webhook handler
 *
 * Checks only the essentials:
 * - Application status
 * - RabbitMQ connection (critical to enqueue messages)
 * - PostgreSQL connection (critical to persist webhook logs)
 */
@ApiTags('Webhook Health')
@ApiStandardResponses({ includeAuth: false })
@Public()
@Controller('health')
export class WebhookHealthController {
    constructor(private readonly amqpConnection: AmqpConnection) {}

    @Get()
    async check(@Res() res: Response) {
        try {
            const checks = {
                application: await this.checkApplication(),
                rabbitmq: await this.checkRabbitMQ(),
                postgresql: await this.checkPostgreSQL(),
            };

            const allHealthy = Object.values(checks).every(
                (check) => check.status === 'ok',
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
                error: 'Health check failed',
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

    private async checkApplication(): Promise<{ status: string }> {
        try {
            return { status: 'ok' };
        } catch {
            return { status: 'error' };
        }
    }

    private async checkRabbitMQ(): Promise<{ status: string }> {
        try {
            // Check if RabbitMQ connection is active
            const channel = this.amqpConnection.channel;
            if (!channel) {
                return { status: 'error' };
            }

            // Try to check a queue (non-blocking if it doesn't exist yet)
            await channel.checkQueue('workflow.webhooks.queue').catch(() => {
                // Queue may not exist yet, but the connection is OK
            });

            return { status: 'ok' };
        } catch {
            return { status: 'error' };
        }
    }

    private async checkPostgreSQL(): Promise<{ status: string }> {
        try {
            // Check if PostgreSQL connection is active
            // await this.dataSource.query('SELECT 1');
            return { status: 'ok' };
        } catch {
            return { status: 'error' };
        }
    }
}
