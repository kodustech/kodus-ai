import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { McpPrincipal } from '../auth/mcp-principal';

/**
 * /mcp/env takes a team key and nothing else (ADR-057, S-45), discovery
 * included: runs after McpAuthGuard, which resolves the credential, and
 * refuses no credential (401) and the first-party service token (403). The
 * Kody chat reaches MCP with that service token, so it never reaches env_*.
 */
@Injectable()
export class McpEnvTeamKeyGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<{ auth?: AuthInfo }>();
        const principal = req.auth?.extra?.principal as
            McpPrincipal | undefined;
        if (!principal)
            throw new UnauthorizedException('Team API key required');
        if (principal.kind !== 'team-key')
            throw new ForbiddenException(
                'The env_* tools take a team API key only',
            );
        return true;
    }
}
