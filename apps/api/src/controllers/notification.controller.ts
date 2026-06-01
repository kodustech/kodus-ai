import {
    Body,
    Controller,
    ForbiddenException,
    Get,
    Param,
    Patch,
    Post,
    Put,
    Query,
    Req,
    Res,
    UseGuards,
    ParseIntPipe,
    DefaultValuePipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request, Response } from 'express';

import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';

import { NotificationQueryService } from '@libs/notifications/application/notification-query.service';
import { NotificationSseService } from '@libs/notifications/application/notification-sse.service';
import {
    RoutingRuleService,
    UpsertRuleDto,
} from '@libs/notifications/application/routing-rule.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationController {
    constructor(
        private readonly queryService: NotificationQueryService,
        private readonly sseService: NotificationSseService,
        private readonly routingRuleService: RoutingRuleService,
    ) {}

    // ── User endpoints ────────────────────────────────────────

    @Get()
    @ApiOperation({ summary: 'List in-app notifications for current user' })
    async list(
        @Req() req: Request,
        @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
        @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
        @Query('unreadOnly') unreadOnly?: string,
    ) {
        const userId = (req as any).user?.uuid;
        return this.queryService.list(userId, {
            page,
            limit: Math.min(limit, 100),
            unreadOnly: unreadOnly === 'true',
        });
    }

    @Get('unread-count')
    @ApiOperation({ summary: 'Get unread notification count' })
    async unreadCount(@Req() req: Request) {
        const userId = (req as any).user?.uuid;
        const count = await this.queryService.unreadCount(userId);
        return { count };
    }

    @Get('stream')
    @ApiOperation({ summary: 'SSE stream for real-time notification updates' })
    async stream(@Req() req: Request, @Res() res: Response) {
        const userId = (req as any).user?.uuid;

        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // Send initial unread count
        const count = await this.queryService.unreadCount(userId);
        res.write(
            `event: unread-count\ndata: ${JSON.stringify({ count })}\n\n`,
        );

        this.sseService.addConnection(userId, res);

        // Heartbeat every 30s to keep the connection alive
        const heartbeat = setInterval(() => {
            try {
                res.write(': heartbeat\n\n');
            } catch {
                clearInterval(heartbeat);
            }
        }, 30_000);

        req.on('close', () => {
            clearInterval(heartbeat);
            this.sseService.removeConnection(userId, res);
        });
    }

    @Patch(':id/read')
    @ApiOperation({ summary: 'Mark a notification as read' })
    async markAsRead(@Param('id') id: string, @Req() req: Request) {
        const userId = (req as any).user?.uuid;
        await this.queryService.markAsRead(id, userId);
        return { success: true };
    }

    @Post('mark-all-read')
    @ApiOperation({ summary: 'Mark all notifications as read' })
    async markAllAsRead(@Req() req: Request) {
        const userId = (req as any).user?.uuid;
        const count = await this.queryService.markAllAsRead(userId);
        return { marked: count };
    }

    @Post('dev/seed')
    @ApiOperation({
        summary: 'Dev-only: seed mock notifications for the current user',
    })
    async seedFakeNotifications(@Req() req: Request) {
        if (process.env.NODE_ENV === 'production') {
            throw new ForbiddenException(
                'Mock notification seeding is disabled in production.',
            );
        }
        const userId = (req as any).user?.uuid;
        const organizationId = (req as any).user?.organization?.uuid;
        return this.queryService.seedFakeNotifications(userId, organizationId);
    }

    // ── Admin endpoints (owner-only) ──────────────────────────

    @Get('config')
    @ApiOperation({
        summary:
            'Notification system configuration consumed by the in-app UI (events, channels, criticalities, categories, roles)',
    })
    async getNotificationConfig() {
        return this.routingRuleService.getConfig();
    }

    @Get('routing-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({ summary: 'List notification routing rules for the org' })
    async getRoutingRules(@Req() req: Request) {
        const organizationId = (req as any).user?.organization?.uuid;
        return this.routingRuleService.findByOrganization(organizationId);
    }

    @Put('routing-rules')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({ summary: 'Upsert notification routing rules' })
    async upsertRoutingRules(
        @Req() req: Request,
        @Body() body: { rules: UpsertRuleDto[] },
    ) {
        const organizationId = (req as any).user?.organization?.uuid;
        return this.routingRuleService.upsertRules(
            organizationId,
            body.rules,
        );
    }

    @Post('routing-rules/reset')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({ summary: 'Reset routing rules to catalog defaults' })
    async resetRoutingRules(@Req() req: Request) {
        const organizationId = (req as any).user?.organization?.uuid;
        return this.routingRuleService.resetToDefaults(organizationId);
    }
}
