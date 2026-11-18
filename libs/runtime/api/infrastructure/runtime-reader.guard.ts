import { ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import {
    ITeamCliKeyService,
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';

import type { RuntimePrincipal } from '../application/run-access.service';

export const RUNTIME_PRINCIPAL = 'runtimePrincipal';

/**
 * Authenticates a Runtime read route with either the dashboard JWT or a team
 * key (`x-team-key`, or `Bearer kodus_*`). The route is @Public() so the global
 * JWT guard lets the team key through; this guard is then the only gate, and
 * the use case does the capability, org, team and repo checks.
 */
@Injectable()
export class RuntimeReaderAuthGuard extends AuthGuard('jwt') {
    constructor(
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly teamKeys: Pick<ITeamCliKeyService, 'validateKey'>,
    ) {
        super();
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const header = request.headers?.['x-team-key'];
        const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers?.authorization ?? '')?.[1];
        const key = (typeof header === 'string' && header) || (bearer?.startsWith('kodus_') ? bearer : undefined);

        if (key) {
            const data = await this.teamKeys.validateKey(key);
            if (!data?.team?.uuid || !data.organization?.uuid) {
                throw new UnauthorizedException('Invalid or revoked team API key');
            }
            const principal: RuntimePrincipal = {
                kind: 'team_key',
                keyId: data.keyId,
                organizationId: data.organization.uuid,
                teamId: data.team.uuid,
                capabilities: data.config?.capabilities ?? [],
                repositoryIds: data.config?.repositoryIds ?? [],
            };
            request[RUNTIME_PRINCIPAL] = principal;
            return true;
        }

        const ok = (await super.canActivate(context)) as boolean;
        if (ok) request[RUNTIME_PRINCIPAL] = { kind: 'user', user: request.user } satisfies RuntimePrincipal;
        return ok;
    }

    handleRequest(err: unknown, user: any) {
        if (err || !user) throw err || new UnauthorizedException('api.users.unauthorized');
        return user;
    }
}
