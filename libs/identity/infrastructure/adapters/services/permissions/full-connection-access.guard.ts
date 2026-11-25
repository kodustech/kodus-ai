import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
} from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';

import { ConnectionAccessService } from './connection-access.service';

/**
 * For reads that cover the whole organization and cannot be narrowed to the
 * repositories of some Git connections: only owners and members granted
 * every connection get them.
 */
@Injectable()
export class FullConnectionAccessGuard implements CanActivate {
    private readonly logger = createLogger(FullConnectionAccessGuard.name);

    // Required: without it the guard could not tell who is restricted.
    constructor(private readonly connectionAccess: ConnectionAccessService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<{
            user?: {
                uuid?: string;
                role?: string;
                organization?: { uuid?: string };
            };
            route?: { path?: string };
        }>();
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
