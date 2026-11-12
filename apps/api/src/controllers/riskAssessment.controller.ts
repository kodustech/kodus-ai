import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PreviewPrRiskUseCase } from '@libs/code-review/application/use-cases/risk/preview-pr-risk.use-case';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkRepoPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { TenantScopeGuard } from '../guards/tenant-scope.guard';
import { PreviewPrRiskDto } from '../dtos/risk-assessment.dto';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';

@ApiTags('Risk Assessment')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('code-review/risk')
@UseGuards(TenantScopeGuard)
export class RiskAssessmentController {
    constructor(
        @Inject(REQUEST) private readonly request: UserRequest,
        private readonly preview: PreviewPrRiskUseCase,
    ) {}

    @Post('preview')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkRepoPermissions({
            action: Action.Update,
            resource: ResourceType.CodeReviewSettings,
            repo: { key: { body: 'repositoryId' } },
        }),
    )
    previewOnPr(@Body() body: PreviewPrRiskDto) {
        return this.preview.execute({
            organizationAndTeamData: {
                organizationId: this.request.user.organization.uuid,
                teamId: body.teamId,
            },
            repositoryId: body.repositoryId,
            prNumber: body.prNumber,
            criteria: body.criteria,
        });
    }
}
