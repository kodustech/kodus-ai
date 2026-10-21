import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { ITeamCliKeyConfig } from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';

/**
 * Who is calling the MCP server, resolved by `McpAuthGuard` from the request
 * credential. Tools must take the organization from here, never from the
 * JSON-RPC arguments.
 *
 * - `service`: the first-party integration (code review agents), signed by
 *   `MCPManagerService` for one organization, any of its teams.
 * - `team-key`: an external client (Cursor, Claude Desktop, …) using a Team
 *   CLI key, bound to one team.
 */
export type McpPrincipal =
    | { kind: 'service'; organizationId: string }
    | {
          kind: 'team-key';
          organizationId: string;
          teamId: string;
          config?: ITeamCliKeyConfig;
      };

/**
 * The MCP SDK forwards `req.auth` to every tool as `extra.authInfo`; the
 * principal travels in its `extra` field.
 */
export function toMcpAuthInfo(
    token: string,
    principal: McpPrincipal,
): AuthInfo {
    return {
        token,
        clientId: principal.kind,
        scopes: [],
        extra: { principal },
    };
}

export function getMcpPrincipal(extra: unknown): McpPrincipal | undefined {
    const principal = (extra as { authInfo?: AuthInfo } | undefined)?.authInfo
        ?.extra?.principal as McpPrincipal | undefined;
    return principal?.organizationId ? principal : undefined;
}
