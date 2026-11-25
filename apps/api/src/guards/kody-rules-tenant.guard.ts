import {
    BadRequestException,
    CanActivate,
    ExecutionContext,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';

import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';

/**
 * Tenant isolation for Kody Rules endpoints that accept a `teamId` (and
 * optionally a `repositoryId`) from the request. Runs before the handler so the
 * controller never calls a service directly:
 *  - the team must belong to the JWT's organization → 404 (never leaks whether
 *    the team exists in another org);
 *  - when a repositoryId is present, the user must have access to it → 403 via
 *    the same AuthorizationService the read use-cases use.
 *
 * The action is inferred from the HTTP method (GET → Read, otherwise Create),
 * matching how these endpoints map to RBAC actions.
 */
@Injectable()
export class KodyRulesTenantGuard implements CanActivate {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        private readonly authorizationService: AuthorizationService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const user = request.user;
        const organizationId = user?.organization?.uuid;

        // Both are read: JSON bodies are parsed on every method, so a value
        // in the body must not hide the one in the query a GET handler reads.
        const teamIds = namedIds(request, 'teamId');

        if (!organizationId || !teamIds.length) {
            throw new NotFoundException('Team not found');
        }

        for (const teamId of teamIds) {
            const teamOrganizationId =
                await this.teamService.findOneOrganizationIdByTeamId(teamId);

            if (!teamOrganizationId || teamOrganizationId !== organizationId) {
                throw new NotFoundException('Team not found');
            }
        }

        const repoIds = namedIds(request, 'repositoryId');

        if (repoIds.length) {
            const action =
                request.method === 'GET' ? Action.Read : Action.Create;

            await this.authorizationService.ensure({
                user,
                action,
                resource: ResourceType.KodyRules,
                repoIds,
            });
        }

        return true;
    }
}

/**
 * Every value of `key` in the body and the query, once each, as a string.
 * A handler receives the raw value and the sync routes match a number against
 * a repository's id, so a number is checked as the id it names; anything else
 * (an object, a boolean) is refused instead of being left out of the check.
 */
function namedIds(
    request: {
        body?: Record<string, unknown>;
        query?: Record<string, unknown>;
    },
    key: string,
): string[] {
    const ids = new Set<string>();
    for (const value of [request.body?.[key], request.query?.[key]].flat()) {
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'string') ids.add(value);
        else if (Number.isFinite(value)) ids.add(String(value));
        else throw new BadRequestException(`${key} must be a string`);
    }
    return [...ids];
}
