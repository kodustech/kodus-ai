import {
    CanActivate,
    ExecutionContext,
    Inject,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { JWT } from '@libs/core/infrastructure/config/types/jwt/jwt';
import {
    ITeamCliKeyService,
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';

import { McpPrincipal, toMcpAuthInfo } from '../auth/mcp-principal';
import { KODUS_MCP_TOKEN_AUDIENCE } from '../utils/mcp-auth.constants';

/**
 * The MCP controllers are `@Public()` (they sit outside the user-JWT guard),
 * so this guard is their only authentication. It accepts either the service
 * token `MCPManagerService` signs for the first-party integration, or a Team
 * CLI key (`x-team-key` or `Authorization: Bearer kodus_…`) for external
 * clients. The resolved principal is attached as `req.auth`, which the MCP
 * SDK hands to every tool as `extra.authInfo`.
 *
 * Discovery (`initialize`, `tools/list`, `ping`) is allowed without a
 * credential: it returns the same static tool catalog to everyone, and the
 * mcp-manager lists `/mcp/issues` tools that way when an organization
 * installs the plugin. Anything else — `tools/call` above all — needs one,
 * and a credential that is sent is always validated.
 */
const DISCOVERY_METHODS = new Set([
    'initialize',
    'notifications/initialized',
    'tools/list',
    'ping',
]);

function isDiscoveryOnly(body: unknown): boolean {
    const messages = Array.isArray(body) ? body : [body];
    return (
        messages.length > 0 &&
        messages.every((message) =>
            DISCOVERY_METHODS.has(
                (message as { method?: unknown })?.method as string,
            ),
        )
    );
}

@Injectable()
export class McpAuthGuard implements CanActivate {
    constructor(
        private readonly jwt: JwtService,
        private readonly config: ConfigService,
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly teamCliKeys: ITeamCliKeyService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<Request>();
        const header = req.headers['x-team-key'];
        if (
            header === undefined &&
            req.headers.authorization === undefined &&
            isDiscoveryOnly(req.body)
        ) {
            return true;
        }

        const teamKey = typeof header === 'string' ? header.trim() : '';
        const bearer =
            req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';

        const token = teamKey || bearer;
        const principal =
            teamKey || bearer.startsWith('kodus_')
                ? await this.fromTeamKey(token)
                : await this.fromServiceToken(bearer);

        (req as Request & { auth?: unknown }).auth = toMcpAuthInfo(
            token,
            principal,
        );
        return true;
    }

    private async fromTeamKey(key: string): Promise<McpPrincipal> {
        const data = key ? await this.teamCliKeys.validateKey(key) : null;
        if (!data?.organization?.uuid || !data?.team?.uuid) {
            throw new UnauthorizedException('Invalid or revoked team API key');
        }
        return {
            kind: 'team-key',
            organizationId: data.organization.uuid,
            teamId: data.team.uuid,
            config: data.config,
        };
    }

    private async fromServiceToken(token: string): Promise<McpPrincipal> {
        const secret = this.config.get<JWT>('jwtConfig')?.secret;
        if (!secret || !token) {
            throw new UnauthorizedException('Team API key required');
        }
        try {
            const claims = await this.jwt.verifyAsync<{
                organizationId?: unknown;
            }>(token, {
                secret,
                algorithms: ['HS256'],
                issuer: KODUS_MCP_TOKEN_AUDIENCE,
                audience: KODUS_MCP_TOKEN_AUDIENCE,
            });
            if (
                typeof claims.organizationId === 'string' &&
                claims.organizationId
            ) {
                return {
                    kind: 'service',
                    organizationId: claims.organizationId,
                };
            }
        } catch {
            // Falls through: an invalid, expired or foreign token is the same
            // 401 as a missing one.
        }
        throw new UnauthorizedException('Invalid MCP credential');
    }
}
