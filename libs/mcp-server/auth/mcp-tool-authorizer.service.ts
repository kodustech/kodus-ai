import {
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';

import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { TEAM_CLI_KEY_CAPABILITIES } from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';

import { getMcpPrincipal, McpPrincipal } from './mcp-principal';

// Same capability the CLI requires to manage rules
// (apps/api/src/controllers/cli/cli-kody-rules.controller.ts), so MCP is not
// a way around it.
const KODY_RULE_WRITE_TOOLS = new Set([
    'KODUS_CREATE_KODY_RULE',
    'KODUS_UPDATE_KODY_RULE',
    'KODUS_DELETE_KODY_RULE',
    'KODUS_CREATE_MEMORY',
]);

/**
 * Runs before every MCP tool. Tool arguments are client input: the
 * organization is replaced by the authenticated one (a different value is
 * rejected, not silently rewritten), and every team named in the arguments
 * must belong to it — or, for a team key, be that key's team.
 */
@Injectable()
export class McpToolAuthorizer {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
    ) {}

    async authorize<T extends Record<string, unknown>>(
        toolName: string,
        args: T,
        extra: unknown,
    ): Promise<T & { organizationId: string }> {
        const principal = getMcpPrincipal(extra);
        if (!principal) {
            throw new UnauthorizedException('MCP credential required');
        }

        const { organizationId } = principal;
        if (
            args?.organizationId !== undefined &&
            args.organizationId !== organizationId
        ) {
            throw new ForbiddenException(
                'organizationId does not match the credential',
            );
        }

        const kodyRule = args?.kodyRule as { teamId?: unknown } | undefined;
        for (const teamId of [args?.teamId, kodyRule?.teamId]) {
            if (teamId !== undefined && teamId !== null && teamId !== '') {
                await this.ensureTeam(principal, teamId);
            }
        }

        if (
            principal.kind === 'team-key' &&
            KODY_RULE_WRITE_TOOLS.has(toolName) &&
            !principal.config?.capabilities?.includes(
                TEAM_CLI_KEY_CAPABILITIES.KODY_RULES_MANAGE,
            )
        ) {
            throw new ForbiddenException(
                'Team API key does not have permission to manage Kody Rules',
            );
        }

        return { ...args, organizationId };
    }

    private async ensureTeam(
        principal: McpPrincipal,
        teamId: unknown,
    ): Promise<void> {
        const allowed =
            principal.kind === 'team-key'
                ? teamId === principal.teamId
                : typeof teamId === 'string' &&
                  (await this.teamService.findOneOrganizationIdByTeamId(
                      teamId,
                  )) === principal.organizationId;
        if (!allowed) {
            throw new NotFoundException('Team not found');
        }
    }
}
