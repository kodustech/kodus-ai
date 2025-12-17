import { FindCodeReviewSettingsLogsUseCase } from '@/core/application/use-cases/codeReviewSettingsLog/find-code-review-settings-logs.use-case';
import { RegisterUserStatusLogUseCase } from '@/core/application/use-cases/user/register-user-status-log.use-case';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
    CheckPolicies,
    PolicyGuard,
} from '../../adapters/services/permissions/policy.guard';
import { checkPermissions } from '../../adapters/services/permissions/policy.handlers';
import { CodeReviewSettingsLogFiltersDto } from '../dtos/code-review-settings-log-filters.dto';
import { UserStatusDto } from '../dtos/user-status-change.dto';

@Controller('user-log')
export class CodeReviewSettingLogController {
    constructor(
        private readonly findCodeReviewSettingsLogsUseCase: FindCodeReviewSettingsLogsUseCase,
        private readonly registerUserStatusLogUseCase: RegisterUserStatusLogUseCase,
    ) {}

    @Post('/status-change')
    public async registerStatusChange(
        @Body() body: UserStatusDto,
    ): Promise<void> {
        return await this.registerUserStatusLogUseCase.execute(body);
    }


    @Get('/code-review-settings')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({
        action: Action.Read,
        resource: ResourceType.Logs
    }))
    public async findCodeReviewSettingsLogs(
        @Query() filters: CodeReviewSettingsLogFiltersDto,
    ) {
        return await this.findCodeReviewSettingsLogsUseCase.execute(filters);
    }
}
