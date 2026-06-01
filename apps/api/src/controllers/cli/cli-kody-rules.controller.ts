import {
    CreateKodyRuleDto,
    KodyRuleSeverity,
} from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/find-rules-in-organization-by-filter.use-case';
import {
    IKodyRule,
    KodyRulesOrigin,
    KodyRulesScope,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    ITeamCliKeyService,
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import { TEAM_CLI_KEY_CAPABILITIES } from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';
import {
    Body,
    Controller,
    ForbiddenException,
    Get,
    Headers,
    Inject,
    Param,
    Patch,
    Post,
    Query,
    UnauthorizedException,
} from '@nestjs/common';
import {
    ApiCreatedResponse,
    ApiHeader,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';
import {
    KodyRuleResponseDto,
    KodyRulesArrayResponseDto,
} from '../../dtos/kody-rules-response.dto';

@ApiTags('CLI Kody Rules')
@ApiStandardResponses()
@Public()
@Controller('cli/kody-rules')
export class CliKodyRulesController {
    constructor(
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly teamCliKeyService: ITeamCliKeyService,

        private readonly createOrUpdateKodyRuleUseCase: CreateOrUpdateKodyRulesUseCase,
        private readonly findKodyRulesUseCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
    ) {}

    @Get()
    @ApiOperation({
        summary: 'List Kody Rules',
        description:
            'Retrieve a list of Kody Rules for the authenticated team.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiHeader({
        name: 'authorization',
        required: false,
        description: 'Bearer Team CLI key (alternative to x-team-key)',
    })
    @ApiQuery({
        name: 'ruleId',
        required: false,
        type: String,
        description: 'Filter by Kody Rule UUID',
    })
    @ApiQuery({
        name: 'repositoryId',
        required: false,
        type: String,
        description: 'Filter by Repository ID',
    })
    @ApiOkResponse({ type: KodyRulesArrayResponseDto })
    async listKodyRules(
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
        @Query('ruleId') ruleId?: string,
        @Query('repositoryId') repositoryId?: string,
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        await this.ensureKodyRulesCapability(authContext);

        const filter: Partial<IKodyRule> = {};
        if (ruleId) filter.uuid = ruleId;
        else if (repositoryId) filter.repositoryId = repositoryId;

        return await this.findKodyRulesUseCase.execute(
            authContext.organizationId,
            filter,
        );
    }

    @Post()
    @ApiOperation({
        summary: 'Create a Kody Rule',
        description: 'Create a new Kody Rule with the provided details.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiHeader({
        name: 'authorization',
        required: false,
        description: 'Bearer Team CLI key (alternative to x-team-key)',
    })
    @ApiCreatedResponse({ type: KodyRuleResponseDto })
    async createKodyRule(
        @Body() body: Partial<IKodyRule>,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        await this.ensureKodyRulesCapability(authContext);

        if (body.uuid != undefined) {
            throw new ForbiddenException(
                'UUID should not be provided when creating a new Kody Rule',
            );
        }
        const requiredFieldsBody = this.convertToDTO(body);

        return await this.createOrUpdateKodyRuleUseCase.execute(
            requiredFieldsBody,
            authContext.organizationId,
            undefined,
            undefined,
            authContext.teamId,
        );
    }

    @Patch(':ruleId')
    @ApiOperation({
        summary: 'Update a Kody Rule',
        description: 'Update an existing Kody Rule with the provided details.',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team CLI key (alternative to Authorization: Bearer)',
    })
    @ApiHeader({
        name: 'authorization',
        required: false,
        description: 'Bearer Team CLI key (alternative to x-team-key)',
    })
    @ApiParam({
        name: 'ruleId',
        required: true,
        type: String,
        description: 'Kody Rule UUID to update',
    })
    @ApiOkResponse({ type: KodyRuleResponseDto })
    async updateKodyRule(
        @Body() body: Partial<IKodyRule>,
        @Param('ruleId') ruleId: string,
        @Headers('x-team-key') teamKey?: string,
        @Headers('authorization') authHeader?: string,
    ) {
        const authContext = await this.resolveCliContext(teamKey, authHeader);
        await this.ensureKodyRulesCapability(authContext);

        if (!ruleId) {
            throw new ForbiddenException('Rule ID is required for update');
        }

        if (body.uuid && body.uuid !== ruleId) {
            throw new ForbiddenException(
                'Body UUID must match the ruleId path parameter',
            );
        }

        const patchPayload = this.convertPatchToDTO(body, ruleId);

        return await this.createOrUpdateKodyRuleUseCase.execute(
            patchPayload,
            authContext.organizationId,
            undefined,
            undefined,
            authContext.teamId,
        );
    }

    private async resolveCliContext(teamKey?: string, authHeader?: string) {
        const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');
        const resolvedTeamKey = teamKey || bearerToken;

        if (!resolvedTeamKey || !resolvedTeamKey.startsWith('kodus_')) {
            throw new UnauthorizedException('Team API key required');
        }

        const teamData =
            await this.teamCliKeyService.validateKey(resolvedTeamKey);

        if (!teamData?.team?.uuid || !teamData?.organization?.uuid) {
            throw new UnauthorizedException('Invalid or revoked team API key');
        }

        return {
            organizationId: teamData.organization.uuid,
            teamId: teamData.team.uuid,
            config: teamData.config,
        };
    }

    private ensureKodyRulesCapability(context: {
        organizationId: string;
        teamId: string;
        config?: {
            capabilities?: string[];
        };
    }) {
        const hasCapability =
            context.config?.capabilities?.includes(
                TEAM_CLI_KEY_CAPABILITIES.KODY_RULES_MANAGE,
            ) ?? false;

        if (!hasCapability) {
            throw new ForbiddenException(
                'Team API key does not have permission to manage Kody Rules',
            );
        }
    }

    private convertToDTO(body: Partial<IKodyRule>) {
        const requiredFields = ['title', 'rule', 'repositoryId'];
        const missingFields = requiredFields.filter(
            (field) => body[field as keyof IKodyRule] == undefined,
        );

        if (missingFields.length > 0) {
            throw new ForbiddenException(
                `Missing required fields: ${missingFields.join(', ')}`,
            );
        }

        return {
            title: body.title,
            rule: body.rule,
            status: body.status || KodyRulesStatus.ACTIVE,
            type: body.type || KodyRulesType.STANDARD,
            path: body.path || '*/**',
            origin: body.origin || KodyRulesOrigin.USER,
            scope: body.scope || KodyRulesScope.FILE,
            severity:
                (body.severity as KodyRuleSeverity) || KodyRuleSeverity.MEDIUM,
            examples: body.examples || [],
            repositoryId: body.repositoryId,
        };
    }

    private convertPatchToDTO(
        body: Partial<IKodyRule>,
        ruleId: string,
    ): CreateKodyRuleDto {
        const fields: Array<keyof IKodyRule> = [
            'title',
            'rule',
            'repositoryId',
            'severity',
            'scope',
            'path',
        ];

        for (const field of fields) {
            if (field in body && body[field] == null) {
                throw new ForbiddenException(
                    `Field '${field}' cannot be set to null or undefined.`,
                );
            }
        }

        return {
            ...body,
            uuid: ruleId,
        } as CreateKodyRuleDto;
    }
}
