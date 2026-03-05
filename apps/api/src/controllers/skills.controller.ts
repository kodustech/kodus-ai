import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';

import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { SkillLoaderService } from '@libs/agents/skills/skill-loader.service';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';

import {
    SkillInstructionsResponseDto,
    SkillMetaResponseDto,
} from '../dtos/skills-response.dto';

@ApiTags('Skills')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('skills')
export class SkillsController {
    constructor(
        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly skillLoaderService: SkillLoaderService,
    ) {}

    @Get(':skillName/meta')
    @ApiParam({ name: 'skillName', example: 'business-rules-validation' })
    @ApiOperation({
        summary: 'Get skill platform metadata',
        description:
            'Return platform-owned metadata from the SKILL.md frontmatter — capabilities, allowed tools and required MCP plugin categories.',
    })
    @ApiOkResponse({ type: SkillMetaResponseDto })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public getSkillMeta(@Param('skillName') skillName: string) {
        return this.skillLoaderService.loadSkillMetaFromFilesystem(skillName);
    }

    @Get(':skillName/instructions')
    @ApiParam({ name: 'skillName', example: 'business-rules-validation' })
    @ApiOperation({
        summary: 'Get skill instructions',
        description:
            'Return compiled instructions from SKILL.md body + references/*.md files.',
    })
    @ApiOkResponse({ type: SkillInstructionsResponseDto })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public getInstructions(@Param('skillName') skillName: string) {
        return {
            instructions: this.skillLoaderService.loadInstructions(skillName),
        };
    }
}
