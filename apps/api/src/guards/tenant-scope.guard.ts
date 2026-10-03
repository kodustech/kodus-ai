import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';

import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';

type Source = Record<string, unknown> | undefined;

function collect(sources: Source[], key: 'teamId' | 'organizationId') {
    const values = new Set<unknown>();
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        values.add(source[key]);
        const nested = source.organizationAndTeamData as Source;
        if (nested && typeof nested === 'object') values.add(nested[key]);
    }
    values.delete(undefined);
    values.delete(null);
    values.delete('');
    return [...values];
}

/**
 * Tenant isolation for controllers whose handlers take a `teamId` or an
 * `organizationId` from the client (path, query, body, or
 * `body.organizationAndTeamData`). The role guards never look at these ids,
 * and several downstream lookups filter by team alone (team parameters), so
 * the check runs once, before any handler:
 *  - an organizationId must be the JWT's organization → 403;
 *  - every teamId must belong to the JWT's organization → 404 (never reveals
 *    whether the team exists elsewhere).
 * Requests without an authenticated user (`@Public()` routes) are left to
 * their own guards.
 */
@Injectable()
export class TenantScopeGuard implements CanActivate {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const organizationId: string | undefined =
            request.user?.organization?.uuid;
        if (!request.user) return true;

        const sources: Source[] = [
            request.params,
            request.query,
            request.body,
        ];

        for (const claimed of collect(sources, 'organizationId')) {
            if (!organizationId || claimed !== organizationId) {
                throw new ForbiddenException(
                    'organizationId does not match the authenticated organization',
                );
            }
        }

        for (const teamId of collect(sources, 'teamId')) {
            const teamOrganizationId =
                typeof teamId === 'string'
                    ? await this.teamService.findOneOrganizationIdByTeamId(
                          teamId,
                      )
                    : undefined;
            if (!organizationId || teamOrganizationId !== organizationId) {
                throw new NotFoundException('Team not found');
            }
        }

        return true;
    }
}
