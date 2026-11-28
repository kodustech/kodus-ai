import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { createLogger } from '@libs/core/log/logger';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import { ConnectionAccessService } from './connection-access.service';

const BILLING_MANAGERS_READ_EVERY_CONNECTION =
    'billing_managers_read_every_connection';

/**
 * Billing managers manage the organization's spend, so they read this
 * across every connection whatever they are granted.
 */
export const BillingManagersReadEveryConnection = () =>
    SetMetadata(BILLING_MANAGERS_READ_EVERY_CONNECTION, true);

/**
 * For reads that cover the whole organization and cannot be narrowed to the
 * repositories of some Git connections: only owners and members granted
 * every connection get them.
 */
@Injectable()
export class FullConnectionAccessGuard implements CanActivate {
    private readonly logger = createLogger(FullConnectionAccessGuard.name);

    // Required: without it the guard could not tell who is restricted.
    constructor(
        private readonly connectionAccess: ConnectionAccessService,
        private readonly reflector: Reflector,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<{
            user?: {
                uuid?: string;
                role?: string;
                organization?: { uuid?: string };
            };
            route?: { path?: string };
        }>();
        if (
            request.user?.role === Role.BILLING_MANAGER &&
            this.reflector.getAllAndOverride<boolean>(
                BILLING_MANAGERS_READ_EVERY_CONNECTION,
                [context.getHandler(), context.getClass()],
            )
        ) {
            return true;
        }

        const restriction = await this.connectionAccess.restrictionFor(
            request.user ?? {},
        );
        if (!restriction) return true;

        this.logger.warn({
            message: 'organization_wide_read_denied_by_connection_scope',
            context: FullConnectionAccessGuard.name,
            metadata: {
                organizationId: request.user?.organization?.uuid,
                userId: request.user?.uuid,
                route: request.route?.path,
            },
        });
        throw new ForbiddenException(
            'This view covers every Git connection of the workspace, and your access covers only some of them.',
        );
    }
}
