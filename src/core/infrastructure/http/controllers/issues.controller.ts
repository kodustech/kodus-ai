import { IssuesEntity } from '@/core/domain/issues/entities/issues.entity';
import {
    Body,
    Controller,
    Get,
    Param,
    Patch,
    Query,
    UseGuards,
} from '@nestjs/common';
import { GetIssuesByFiltersDto } from '../dtos/get-issues-by-filters.dto';
import { GetTotalIssuesUseCase } from '@/core/application/use-cases/issues/get-total-issues.use-case';
import { GetIssueByIdUseCase } from '@/core/application/use-cases/issues/get-issue-by-id.use-case';
import { UpdateIssuePropertyUseCase } from '@/core/application/use-cases/issues/update-issue-property.use-case';
import { GetIssuesUseCase } from '@/core/application/use-cases/issues/get-issues.use-case';
import {
    CheckPolicies,
    PolicyGuard,
} from '../../adapters/services/permissions/policy.guard';
import { checkPermissions } from '../../adapters/services/permissions/policy.handlers';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';

@Controller('issues')
export class IssuesController {
    constructor(
        private readonly getIssuesUseCase: GetIssuesUseCase,
        private readonly getTotalIssuesUseCase: GetTotalIssuesUseCase,
        private readonly getIssueByIdUseCase: GetIssueByIdUseCase,
        private readonly updateIssuePropertyUseCase: UpdateIssuePropertyUseCase,
    ) {}

    @Get()
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({
        action: Action.Read,
        resource: ResourceType.Issues
    }))
    async getIssues(@Query() query: GetIssuesByFiltersDto) {
        return this.getIssuesUseCase.execute(query);
    }

    @Get('count')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({
        action: Action.Read,
        resource: ResourceType.Issues
    }))
    async countIssues(@Query() query: GetIssuesByFiltersDto) {
        return await this.getTotalIssuesUseCase.execute(query);
    }

    @Get(':id')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({
        action: Action.Read,
        resource: ResourceType.Issues
    }))
    async getIssueById(@Param('id') id: string) {
        return await this.getIssueByIdUseCase.execute(id);
    }

    @Patch(':id')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({
        action: Action.Update,
        resource: ResourceType.Issues
    }))
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
