import {
    Controller,
    Get,
    Param,
    UseGuards,
    HttpStatus,
    HttpCode,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    AppliesConnectionScope,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { CheckPolicies } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { JOB_STATUS_SERVICE_TOKEN } from '@libs/core/workflow/domain/contracts/job-status.service.contract';
import { IJobStatusService } from '@libs/core/workflow/domain/contracts/job-status.service.contract';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { FullConnectionAccessGuard } from '@libs/identity/infrastructure/adapters/services/permissions/full-connection-access.guard';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';

/**
 * Job history is not kept forever: finished jobs (COMPLETED, FAILED,
 * CANCELLED) are deleted 30 days after their last update
 * (WorkflowJobRetentionService); CLI review jobs are kept for share links.
 * A removed job answers like an unknown one: `{ status: 404, message: 'Job
 * not found' }`.
 */
@ApiTags('Workflow Queue')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('workflow-queue')
@UseGuards(PolicyGuard)
export class WorkflowQueueController {
    constructor(
        @Inject(JOB_STATUS_SERVICE_TOKEN)
        private readonly jobStatusService: IJobStatusService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    /** Jobs of another organization answer like unknown ones. */
    private ownJob<
        T extends
            | { organizationAndTeamData?: { organizationId?: string } }
            | null
            | undefined,
    >(job: T): T | null {
        const organizationId = this.request?.user?.organization?.uuid;
        return job &&
            organizationId &&
            job.organizationAndTeamData?.organizationId === organizationId
            ? job
            : null;
    }

    @Get('/jobs/:jobId')
    @AppliesConnectionScope()
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @UseGuards(FullConnectionAccessGuard)
    @HttpCode(HttpStatus.OK)
    async getJobStatus(@Param('jobId') jobId: string) {
        const job = this.ownJob(
            await this.jobStatusService.getJobStatus(jobId),
        );

        if (!job) {
            return {
                status: HttpStatus.NOT_FOUND,
                message: 'Job not found',
            };
        }

        return {
            status: HttpStatus.OK,
            data: job,
        };
    }

    @Get('/jobs/:jobId/detail')
    @AppliesConnectionScope()
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @UseGuards(FullConnectionAccessGuard)
    @HttpCode(HttpStatus.OK)
    async getJobDetail(@Param('jobId') jobId: string) {
        const detail = await this.jobStatusService.getJobDetail(jobId);

        if (!detail || !this.ownJob(detail.job)) {
            return {
                status: HttpStatus.NOT_FOUND,
                message: 'Job not found',
            };
        }

        return {
            status: HttpStatus.OK,
            data: detail,
        };
    }

    @Get('/metrics')
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @HttpCode(HttpStatus.OK)
    async getMetrics() {
        const metrics = await this.jobStatusService.getMetrics();

        return {
            status: HttpStatus.OK,
            data: metrics,
        };
    }
}
