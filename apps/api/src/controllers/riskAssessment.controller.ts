import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PreviewPrRiskUseCase } from '@libs/code-review/application/use-cases/risk/preview-pr-risk.use-case';
import { PreviewPrApprovalUseCase } from '@libs/code-review/application/use-cases/approval/preview-pr-approval.use-case';
import { DEFAULT_RISK_CRITERIA } from '@libs/code-review/domain/risk/default-risk-criteria';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import {
    checkPermissions,
    checkRepoPermissions,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { TenantScopeGuard } from '../guards/tenant-scope.guard';
import {
    PreviewPrApprovalDto,
    PreviewPrRiskDto,
} from '../dtos/risk-assessment.dto';
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
        private readonly approvalPreview: PreviewPrApprovalUseCase,
    ) {}

    /** The rules Kodus applies unless a team turns them off or edits them. */
    @Get('default-criteria')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    defaultCriteria() {
        return DEFAULT_RISK_CRITERIA;
    }

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

    @Post('approval-preview')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkRepoPermissions({
            action: Action.Update,
            resource: ResourceType.CodeReviewSettings,
            repo: { key: { body: 'repositoryId' } },
        }),
    )
    previewApprovalOnPr(@Body() body: PreviewPrApprovalDto) {
        return this.approvalPreview.execute({
            organizationAndTeamData: {
                organizationId: this.request.user.organization.uuid,
                teamId: body.teamId,
            },
            repositoryId: body.repositoryId,
            prNumber: body.prNumber,
            policies: body.policies,
            assumeClean: body.assumeClean,
            assumeEnabled: body.assumeEnabled,
        });
    }
}
