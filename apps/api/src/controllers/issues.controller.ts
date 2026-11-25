import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    Inject,
    Param,
    Patch,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { BuildFixPromptUseCase } from '@libs/issues/application/use-cases/build-fix-prompt.use-case';
import { GetIssueByIdUseCase } from '@libs/issues/application/use-cases/get-issue-by-id.use-case';
import { GetIssuesUseCase } from '@libs/issues/application/use-cases/get-issues.use-case';
import { GetTotalIssuesUseCase } from '@libs/issues/application/use-cases/get-total-issues.use-case';
import { UpdateIssuePropertyUseCase } from '@libs/issues/application/use-cases/update-issue-property.use-case';
import { IssuesEntity } from '@libs/issues/domain/entities/issues.entity';
import {
    DEEP_SCAN_NOT_ENABLED_MESSAGE,
    DeepScanGate,
} from '@libs/security-scan/application/deep-scan.gate';

import { GetIssuesByFiltersDto } from '../dtos/get-issues-by-filters.dto';
import {
    IssuesFixPromptRequestDto,
    IssuesFixPromptResponseDto,
} from '../dtos/issues-fix-prompt.dto';
import { TenantScopeGuard } from '../guards/tenant-scope.guard';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { ApiArrayResponseDto } from '../dtos/api-response.dto';
import {
    IssueResponseDto,
    IssuesCountResponseDto,
} from '../dtos/issues-response.dto';

@ApiTags('Issues')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@UseGuards(TenantScopeGuard)
@Controller('issues')
export class IssuesController {
    constructor(
        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly getIssuesUseCase: GetIssuesUseCase,
        private readonly getTotalIssuesUseCase: GetTotalIssuesUseCase,
        private readonly getIssueByIdUseCase: GetIssueByIdUseCase,
        private readonly updateIssuePropertyUseCase: UpdateIssuePropertyUseCase,
        private readonly buildFixPromptUseCase: BuildFixPromptUseCase,
        private readonly deepScanGate: DeepScanGate,
    ) {}

    @Get()
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.Issues,
        }),
    )
    @ApiOperation({
        summary: 'List issues',
        description: 'Return issues filtered by query parameters.',
    })
    @ApiOkResponse({ type: ApiArrayResponseDto })
    async getIssues(@Query() query: GetIssuesByFiltersDto) {
        return this.getIssuesUseCase.execute(query);
    }

    @Get('count')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.Issues,
        }),
    )
    @ApiOperation({
        summary: 'Count issues',
        description: 'Return the number of issues matching the filters.',
    })
    @ApiOkResponse({ type: IssuesCountResponseDto })
    async countIssues(@Query() query: GetIssuesByFiltersDto) {
        return await this.getTotalIssuesUseCase.execute(query);
    }

    @Post('fix-prompt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.Issues,
        }),
    )
    @ApiOperation({
        summary: 'Build a fix prompt',
        description:
            "A prompt for the developer's own coding agent to fix the given issues: location, explanation, suggested fix, attack path and reproduction test. Only issues in repositories the caller may read are included. Part of the deep scan's private alpha: refused for an organization it is not enabled for.",
    })
    @ApiOkResponse({ type: IssuesFixPromptResponseDto })
    async buildFixPrompt(@Body() body: IssuesFixPromptRequestDto) {
        // Part of the deep scan's private alpha, behind the same gate.
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException('Organization not found');
        }
        if (!(await this.deepScanGate.isEnabledFor(organizationId))) {
            throw new ForbiddenException(DEEP_SCAN_NOT_ENABLED_MESSAGE);
        }
        return await this.buildFixPromptUseCase.execute(body.ids);
    }

    @Get(':id')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.Issues,
        }),
    )
    @ApiOperation({
        summary: 'Get issue by id',
        description: 'Return a single issue by UUID.',
    })
    @ApiOkResponse({ type: IssueResponseDto })
    async getIssueById(@Param('id') id: string) {
        return await this.getIssueByIdUseCase.execute(id);
    }

    @Patch(':id')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.Issues,
        }),
    )
    @ApiOperation({
        summary: 'Update issue property',
        description: 'Update issue status, label, or severity.',
    })
    @ApiOkResponse({ type: IssueResponseDto })
    async updateIssueProperty(
        @Param('id') id: string,
        @Body() body: { field: 'severity' | 'label' | 'status'; value: string },
    ): Promise<IssuesEntity | null> {
        return await this.updateIssuePropertyUseCase.execute(
            id,
            body.field,
            body.value,
        );
    }
}
