import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { EnterpriseTierGuard } from '@libs/ee/license/guards/enterprise-tier.guard';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { FindCodeReviewSettingsLogsUseCase } from '@libs/ee/codeReviewSettingsLog/application/use-cases/find-code-review-settings-logs.use-case';
import { RegisterUserStatusLogUseCase } from '@libs/ee/codeReviewSettingsLog/application/use-cases/register-use-status-log.use-case';
import { CodeReviewSettingsLogFiltersDto } from '@libs/ee/codeReviewSettingsLog/dtos/code-review-settings-log-filters.dto';
import { UserStatusDto } from '@libs/ee/codeReviewSettingsLog/dtos/user-status-change.dto';
import {
    ApiBearerAuth,
    ApiNoContentResponse,
    ApiOperation,
    ApiOkResponse,
    ApiTags,
} from '@nestjs/swagger';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { CodeReviewSettingsLogResponseDto } from '../dtos/code-review-settings-log-response.dto';

@ApiTags('Code Review Logs')
@ApiStandardResponses()
@UseGuards(EnterpriseTierGuard)
@Controller('user-log')
export class CodeReviewSettingLogController {
    constructor(
        private readonly findCodeReviewSettingsLogsUseCase: FindCodeReviewSettingsLogsUseCase,
        private readonly registerUserStatusLogUseCase: RegisterUserStatusLogUseCase,
    ) {}

    @Post('/status-change')
    @Public()
    @ApiOperation({
        summary: 'Register user status change',
        description: 'Registers a user status change log entry.',
    })
    @ApiNoContentResponse({ description: 'Status change registered' })
    public async registerStatusChange(
        @Body() body: UserStatusDto,
    ): Promise<void> {
        return await this.registerUserStatusLogUseCase.execute(body);
    }

    @Get('/code-review-settings')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.Logs,
        }),
    )
    @ApiOperation({
        summary: 'List code review settings logs',
        description: 'Return audit logs for code review settings changes.',
    })
    @ApiOkResponse({ type: CodeReviewSettingsLogResponseDto })
    public async findCodeReviewSettingsLogs(
        @Query() filters: CodeReviewSettingsLogFiltersDto,
    ) {
        return await this.findCodeReviewSettingsLogsUseCase.execute(filters);
    }
}
