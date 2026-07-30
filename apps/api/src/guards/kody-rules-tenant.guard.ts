import {
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

        const teamId = request.body?.teamId ?? request.query?.teamId;

        if (!organizationId || !teamId) {
            throw new NotFoundException('Team not found');
        }

        const teamOrganizationId =
            await this.teamService.findOneOrganizationIdByTeamId(teamId);

        if (!teamOrganizationId || teamOrganizationId !== organizationId) {
            throw new NotFoundException('Team not found');
        }

        const repositoryId =
            request.body?.repositoryId ?? request.query?.repositoryId;

        if (repositoryId) {
            const action =
                request.method === 'GET' ? Action.Read : Action.Create;

            await this.authorizationService.ensure({
                user,
                action,
                resource: ResourceType.KodyRules,
                repoIds: [repositoryId],
            });
        }

        return true;
    }
}
