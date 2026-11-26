import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { createLogger } from '@libs/core/log/logger';
import { IS_PUBLIC_KEY } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { ConnectionAccessService } from '@libs/identity/infrastructure/adapters/services/permissions/connection-access.service';

export const COCKPIT_ORGANIZATION_WIDE = 'cockpit:organization-wide';

/** A Cockpit read with no repository filter: only members who see every Git connection get it. */
export const CockpitOrganizationWide = () =>
    SetMetadata(COCKPIT_ORGANIZATION_WIDE, true);

/**
 * Cockpit aggregates the whole organization unless a repository is named.
 * A member granted only some of the workspace's Git connections reads it one
 * repository at a time, and only the repositories of those connections.
 */
@Injectable()
export class CockpitConnectionScopeGuard implements CanActivate {
    private readonly logger = createLogger(CockpitConnectionScopeGuard.name);

    constructor(
        private readonly reflector: Reflector,
        private readonly connectionAccess: ConnectionAccessService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const targets = [context.getHandler(), context.getClass()];
        if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
            return true;
        }

        const request = context.switchToHttp().getRequest<{
            user?: {
                uuid?: string;
                role?: string;
                organization?: { uuid?: string };
            };
            query?: Record<string, unknown>;
        }>();
        const restriction = await this.connectionAccess.restrictionFor(
            request.user ?? {},
        );
        if (!restriction) return true;

        const repository = request.query?.repository;
        const organizationWide = this.reflector.getAllAndOverride<boolean>(
            COCKPIT_ORGANIZATION_WIDE,
            targets,
        );
        if (
            !organizationWide &&
            typeof repository === 'string' &&
            repository &&
            restriction.allowsRepository({ name: repository })
        ) {
            return true;
        }

        this.logger.warn({
            message: 'cockpit_read_denied_by_connection_scope',
            context: CockpitConnectionScopeGuard.name,
            metadata: {
                organizationId: request.user?.organization?.uuid,
                userId: request.user?.uuid,
                repository: typeof repository === 'string' ? repository : null,
                organizationWide: Boolean(organizationWide),
            },
        });
        throw new ForbiddenException(
            organizationWide
                ? 'This view covers every Git connection of the workspace, and your access covers only some of them.'
                : 'Your access covers some of the Git connections of the workspace: choose one of their repositories.',
        );
    }
}
