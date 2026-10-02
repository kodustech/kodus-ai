import {
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JWT } from '@libs/core/infrastructure/config/types/jwt/jwt';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/delete-rule-in-organization-by-id.use-case';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';

import { KODUS_MCP_TOKEN_AUDIENCE } from '../../utils/mcp-auth.constants';

@Injectable()
export class DeleteKodyRuleFromMcpUseCase {
    constructor(
        private readonly jwt: JwtService,
        private readonly config: ConfigService,
        @Inject(TEAM_SERVICE_TOKEN) private readonly teams: ITeamService,
        private readonly deleteRule: DeleteRuleInOrganizationByIdKodyRulesUseCase,
    ) {}

    async execute(input: {
        ruleId: string;
        organizationId: string;
        teamId?: string;
        authorization?: string;
    }) {
        const secret = this.config.get<JWT>('jwtConfig')?.secret;
        const match = input.authorization?.match(/^Bearer\s+(\S+)$/i);
        if (!secret || !match) throw new UnauthorizedException();

        let organizationId: string;
        try {
            const claims = await this.jwt.verifyAsync<{
                organizationId?: string;
            }>(match[1], {
                secret,
                algorithms: ['HS256'],
                issuer: KODUS_MCP_TOKEN_AUDIENCE,
                audience: KODUS_MCP_TOKEN_AUDIENCE,
            });
            if (
                typeof claims.organizationId !== 'string' ||
                !claims.organizationId
            ) {
                throw new UnauthorizedException();
            }
            organizationId = claims.organizationId;
        } catch {
            throw new UnauthorizedException();
        }

        if (input.organizationId !== organizationId)
            throw new ForbiddenException();
        if (input.teamId) {
            const teamOrganizationId =
                await this.teams.findOneOrganizationIdByTeamId(input.teamId);
            if (teamOrganizationId !== organizationId)
                throw new NotFoundException('Team not found');
        }

        return this.deleteRule.execute(input.ruleId, {
            source: 'cli',
            organizationId,
            teamId: input.teamId,
            userId: 'kody-delete-mcp-tool',
            userEmail: 'kody@kodus.io',
        });
    }
}
