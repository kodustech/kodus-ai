import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Inject,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    ApiBearerAuth,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';

import { BusinessValidationService } from '@libs/agents/business-validation/business-validation.service';
import { BusinessLogicInsightsService } from '@libs/agents/business-validation/runs/insights.service';
import {
    type BusinessLogicConfig,
    resolveBusinessLogicSettings,
} from '@libs/agents/business-validation/settings';
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

import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';

const canReadSettings = checkPermissions({
    action: Action.Read,
    resource: ResourceType.CodeReviewSettings,
});

const canReadCockpit = checkPermissions({
    action: Action.Read,
    resource: ResourceType.Cockpit,
});

/** What the Business Logic settings page and the Cockpit intent view read. */
@ApiTags('Business Logic')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('business-logic')
export class BusinessLogicController {
    constructor(
        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly businessValidationService: BusinessValidationService,
        private readonly insights: BusinessLogicInsightsService,
    ) {}

    private organizationId(): string {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException('Organization not found');
        }
        return organizationId;
    }

    @Get('status')
    @ApiOperation({
        summary: 'Business Logic status',
        description:
            'Whether Business Logic is working or paused, the last task read, and what happened over the last 30 days.',
    })
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @ApiQuery({ name: 'repositoryId', type: String, required: false })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadSettings)
    status(
        @Query('teamId') teamId: string,
        @Query('repositoryId') repositoryId?: string,
    ) {
        return this.insights.status(this.organizationId(), {
            teamId,
            repositoryId:
                repositoryId && repositoryId !== 'global'
                    ? repositoryId
                    : undefined,
        });
    }

    @Get('task-sources')
    @ApiOperation({
        summary: 'Task sources',
        description:
            'The connected plugins Business Logic can read tasks from: managed trackers and custom plugins.',
    })
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadSettings)
    taskSources(@Query('teamId') teamId: string) {
        return this.businessValidationService.taskSources({
            organizationId: this.organizationId(),
            teamId,
        });
    }

    @Get('task-sources/:integrationId/tools')
    @ApiOperation({
        summary: 'Tools that read one task',
        description:
            "A custom plugin's tools that can read one task by its id, best first. Tools that write are never listed.",
    })
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadSettings)
    readTools(
        @Param('integrationId') integrationId: string,
        @Query('teamId') teamId: string,
    ) {
        return this.businessValidationService.readTools(
            { organizationId: this.organizationId(), teamId },
            integrationId,
        );
    }

    @Post('try')
    @ApiOperation({
        summary: 'Try reading a task',
        description:
            'Reads one task the way a validation would, with the settings on screen, and says what Kody found in it.',
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadSettings)
    tryRead(
        @Body()
        body: {
            teamId: string;
            task: string;
            settings?: BusinessLogicConfig;
        },
    ) {
        if (!body?.teamId || !body?.task?.trim()) {
            throw new BadRequestException('teamId and task are required');
        }
        return this.businessValidationService.tryRead(
            { organizationId: this.organizationId(), teamId: body.teamId },
            body.task.trim(),
            resolveBusinessLogicSettings(body.settings),
        );
    }

    @Get('runs')
    @ApiOperation({
        summary: "A pull request's validations",
        description:
            'Every business-logic run on a pull request, newest first: references found, how each was resolved, the trackers asked and why it was skipped.',
    })
    @ApiQuery({ name: 'repositoryId', type: String, required: true })
    @ApiQuery({ name: 'prNumber', type: Number, required: true })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadSettings)
    runs(
        @Query('repositoryId') repositoryId: string,
        @Query('prNumber') prNumber: string,
    ) {
        const pullRequestNumber = Number(prNumber);
        if (!repositoryId || !Number.isInteger(pullRequestNumber)) {
            throw new BadRequestException(
                'repositoryId and prNumber are required',
            );
        }
        return this.insights.pullRequestRuns({
            organizationId: this.organizationId(),
            repositoryId,
            pullRequestNumber,
        });
    }

    @Get('intent')
    @ApiOperation({
        summary: 'Delivered as asked',
        description:
            'Pull requests checked against their task over a range: share that met it, changes not in the task, findings developers agreed with, and the split by author and team.',
    })
    @ApiQuery({ name: 'startDate', type: String, required: true })
    @ApiQuery({ name: 'endDate', type: String, required: true })
    @ApiQuery({ name: 'teamId', type: String, required: false })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadCockpit)
    intent(
        @Query('startDate') startDate: string,
        @Query('endDate') endDate: string,
        @Query('teamId') teamId?: string,
    ) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
            throw new BadRequestException(
                'startDate and endDate must be dates',
            );
        }
        // The end date names a whole day.
        end.setUTCHours(23, 59, 59, 999);
        return this.insights.intent(this.organizationId(), {
            startDate: start,
            endDate: end,
            teamId,
        });
    }
}
