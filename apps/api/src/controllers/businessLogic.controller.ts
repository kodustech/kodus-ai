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
import { summarizeIntent } from '@libs/agents/business-validation/runs/insights';
import { BusinessLogicInsightsService } from '@libs/agents/business-validation/runs/insights.service';
import { type BusinessLogicConfig } from '@libs/agents/business-validation/settings';
import { TriggerBusinessValidationUseCase } from '@libs/platform/application/use-cases/codeManagement/trigger-business-validation.use-case';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    checkPermissions,
    checkRepoPermissions,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';

import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { TenantScopeGuard } from '../guards/tenant-scope.guard';

const canReadSettings = checkPermissions({
    action: Action.Read,
    resource: ResourceType.CodeReviewSettings,
});

// A test and a task read spend the org's model and read tasks with its
// tracker credentials; a test can post to the PR. The repository a request
// names is checked again in the handler.
const canEditSettings = checkPermissions({
    action: Action.Update,
    resource: ResourceType.CodeReviewSettings,
});

// A PR's runs carry its tasks and verdicts: scoped to its repository.
const canReadRepositoryRuns = checkRepoPermissions({
    action: Action.Read,
    resource: ResourceType.CodeReviewSettings,
    repo: { key: { query: 'repositoryId' } },
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
// Runs and settings are looked up by team: the team from the request must be
// one of the caller's organization.
@UseGuards(TenantScopeGuard)
export class BusinessLogicController {
    constructor(
        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly businessValidationService: BusinessValidationService,
        private readonly insights: BusinessLogicInsightsService,
        private readonly triggerBusinessValidation: TriggerBusinessValidationUseCase,
        private readonly authorization: AuthorizationService,
    ) {}

    /** Throws unless the caller may do `action` on this repository's settings. */
    private async ensureRepository(
        action: Action,
        repositoryId: string | undefined,
    ): Promise<void> {
        if (!repositoryId || repositoryId === 'global') {
            return;
        }
        await this.authorization.ensure({
            user: this.request.user,
            action,
            resource: ResourceType.CodeReviewSettings,
            repoIds: [repositoryId],
        });
    }

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
    async status(
        @Query('teamId') teamId: string,
        @Query('repositoryId') repositoryId?: string,
    ) {
        await this.ensureRepository(Action.Read, repositoryId);
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
    @CheckPolicies(canEditSettings)
    async tryRead(
        @Body()
        body: {
            teamId: string;
            task: string;
            settings?: BusinessLogicConfig;
            /** The settings page's repository, so `#12` is its issue. */
            repositoryId?: string;
        },
    ) {
        if (!body?.teamId || !body?.task?.trim()) {
            throw new BadRequestException('teamId and task are required');
        }
        await this.ensureRepository(Action.Update, body.repositoryId);
        return this.triggerBusinessValidation.tryReadTask({
            organizationAndTeamData: {
                organizationId: this.organizationId(),
                teamId: body.teamId,
            },
            task: body.task.trim(),
            settings: body.settings,
            repositoryId: body.repositoryId,
        });
    }

    @Post('test')
    @ApiOperation({
        summary: 'Test on a pull request',
        description:
            'Runs Business Logic on a real pull request with the settings on screen, saved or not, and shows each step: references found, the tracker and tools that read each task, the verdict, and the comment it would post. Writes nothing; `previewToken` posts this result with `test/post`.',
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canEditSettings)
    test(
        @Body()
        body: {
            teamId: string;
            prUrl: string;
            settings?: BusinessLogicConfig;
            taskInput?: string;
        },
    ) {
        if (!body?.teamId || !body?.prUrl?.trim()) {
            throw new BadRequestException('teamId and prUrl are required');
        }
        return this.triggerBusinessValidation.testOnPullRequest({
            organizationAndTeamData: {
                organizationId: this.organizationId(),
                teamId: body.teamId,
            },
            prUrl: body.prUrl.trim(),
            settings: body.settings,
            taskInput: body.taskInput,
            // The PR's repository, which the URL names: not only the page's.
            authorize: (repositoryId) =>
                this.ensureRepository(Action.Update, repositoryId),
        });
    }

    @Post('test/post')
    @ApiOperation({
        summary: 'Post a test to its pull request',
        description:
            'Posts the result a test showed, as `@kody -v business-logic` would, without running it again.',
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canEditSettings)
    postTest(@Body() body: { teamId: string; previewToken: string }) {
        if (!body?.teamId || !body?.previewToken) {
            throw new BadRequestException(
                'teamId and previewToken are required',
            );
        }
        return this.triggerBusinessValidation.postPreview({
            organizationAndTeamData: {
                organizationId: this.organizationId(),
                teamId: body.teamId,
            },
            previewToken: body.previewToken,
            authorize: (repositoryId) =>
                this.ensureRepository(Action.Update, repositoryId),
        });
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
    @CheckPolicies(canReadRepositoryRuns)
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
    @ApiQuery({
        name: 'repository',
        type: String,
        required: false,
        description:
            "The Cockpit's repository picker: `owner/name`. All the caller can read when absent.",
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadCockpit)
    async intent(
        @Query('startDate') startDate: string,
        @Query('endDate') endDate: string,
        @Query('teamId') teamId?: string,
        @Query('repository') repository?: string,
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
        // Within the repositories the caller may read: all of them for an
        // org-wide role, its own for a repository admin.
        const readable = await this.authorization.getRepositoryScope({
            user: this.request.user,
            action: Action.Read,
            resource: ResourceType.Cockpit,
        });
        if (readable !== null && !readable.length) {
            return summarizeIntent([]);
        }
        return this.insights.intent(this.organizationId(), {
            startDate: start,
            endDate: end,
            teamId,
            ...(readable ? { repositoryIds: readable } : {}),
            ...(repository?.trim()
                ? { repositoryName: repository.trim() }
                : {}),
        });
    }
}
