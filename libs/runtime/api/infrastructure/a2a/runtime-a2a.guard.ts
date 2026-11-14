import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Inject,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import {
    type ITeamCliKeyService,
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import type { EnvKeyPrincipal } from '../../domain/env-tools';

export type RuntimeA2ARequest = Request & {
    runtimeA2APrincipal?: EnvKeyPrincipal;
};

/** Every task operation authenticates again; neither user JWT nor MCP service JWT is a team key. */
@Injectable()
export class RuntimeA2ABearerGuard implements CanActivate {
    constructor(
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly keys: Pick<ITeamCliKeyService, 'validateKey'>,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<RuntimeA2ARequest>();
        const values = req.rawHeaders.filter(
            (_value, i) =>
                i % 2 === 0 &&
                req.rawHeaders[i].toLowerCase() === 'authorization',
        );
        const token = req.headers.authorization?.match(
            /^Bearer[ \t]+(kodus_[A-Za-z0-9_-]{1,250})$/i,
        )?.[1];
        if (values.length !== 1 || !token)
            throw new UnauthorizedException(
                'A bearer team API key is required',
            );
        let data;
        try {
            data = await this.keys.validateKey(token);
        } catch {
            throw new UnauthorizedException('Invalid or revoked team API key');
        }
        if (!data?.keyId || !data.organization?.uuid || !data.team?.uuid)
            throw new UnauthorizedException('Invalid or revoked team API key');
        const capabilities = Array.isArray(data.config?.capabilities)
            ? data.config.capabilities
            : [];
        if (!capabilities.includes('findings:submit'))
            throw new ForbiddenException('findings:submit is required');
        req.runtimeA2APrincipal = {
            keyId: data.keyId,
            organizationId: data.organization.uuid,
            teamId: data.team.uuid,
            capabilities: [...capabilities],
            repositoryIds: Array.isArray(data.config?.repositoryIds)
                ? [...data.config.repositoryIds]
                : [],
        };
        return true;
    }
}
