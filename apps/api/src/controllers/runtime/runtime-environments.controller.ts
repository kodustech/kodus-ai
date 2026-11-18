import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { CheckPolicies, PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import {
    CreateRuntimeEnvironmentUseCase,
    GetRuntimeEnvironmentUseCase,
    ListEnvironmentBlockersUseCase,
    ListEnvironmentStatusesUseCase,
    ListRuntimeEnvironmentsUseCase,
    RequestEnvironmentSetupUseCase,
    UpdateEnvironmentSettingsUseCase,
} from '@libs/runtime/api/application/use-cases/environments.use-cases';
import { ApplyBlockerFixUseCase } from '@libs/runtime/api/application/use-cases/apply-blocker-fix.use-case';

import { ProposeInferredRecipeUseCase } from '@libs/runtime/api/application/use-cases/propose-inferred-recipe.use-case';
import { ListEnvironmentLessonsUseCase, UpdateEnvironmentLessonUseCase } from '@libs/runtime/api/application/use-cases/lessons.use-cases';
import { SimulateRuntimeRunUseCase } from '@libs/runtime/api/application/use-cases/simulate.use-case';
import { EnvironmentRepositoriesUseCase } from '@libs/runtime/api/application/use-cases/environment-repositories.use-cases';

import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';
import {
    AddEnvironmentRepositoryDto,
    ApplyBlockerFixDto,
    CreateRuntimeEnvironmentDto,
    SimulateRunDto,
    UpdateEnvironmentRepositoryDto,
    UpdateEnvironmentSettingsDto,
} from './runtime.dto';
import { RuntimeReleaseGuard } from './runtime-release.guard';

/**
 * Kody Runtime environments (§7): read from the product table and the Run
 * projection; another org's environment is 404. Writes check the repo.
 */
@ApiTags('Kody Runtime')
@ApiStandardResponses()
@ApiBearerAuth('jwt')
@Controller('runtime/environments')
@UseGuards(RuntimeReleaseGuard, PolicyGuard)
export class RuntimeEnvironmentsController {
    constructor(
        private readonly listEnvironmentsUseCase: ListRuntimeEnvironmentsUseCase,
        private readonly getEnvironmentUseCase: GetRuntimeEnvironmentUseCase,
        private readonly listBlockersUseCase: ListEnvironmentBlockersUseCase,
        private readonly createEnvironmentUseCase: CreateRuntimeEnvironmentUseCase,
        private readonly requestSetupUseCase: RequestEnvironmentSetupUseCase,
        private readonly applyBlockerFixUseCase: ApplyBlockerFixUseCase,
        private readonly proposeInferredRecipeUseCase: ProposeInferredRecipeUseCase,
        private readonly listLessonsUseCase: ListEnvironmentLessonsUseCase,
        private readonly updateLessonUseCase: UpdateEnvironmentLessonUseCase,
        private readonly updateEnvironmentSettingsUseCase: UpdateEnvironmentSettingsUseCase,
        private readonly simulateRunUseCase: SimulateRuntimeRunUseCase,
        private readonly repositoriesUseCase: EnvironmentRepositoriesUseCase,
        private readonly listStatusesUseCase: ListEnvironmentStatusesUseCase,
    ) {}

    @Get()
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({ summary: 'List environments', description: 'Environments of the org with 7-day boot metrics.' })
    listEnvironments(@Req() req: UserRequest) {
        return this.listEnvironmentsUseCase.execute({ user: req.user });
    }

    // Before ':id', which would take "status" for an environment id.
    @Get('status')
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({
        summary: 'Environment setup statuses',
        description: "Each environment's state and its setup's times, without metrics: what a screen polls while a setup runs.",
    })
    listStatuses(@Req() req: UserRequest) {
        return this.listStatusesUseCase.execute({ user: req.user });
    }

    @Post()
    @HttpCode(202)
    @CheckPolicies(checkPermissions({ action: Action.Update, resource: ResourceType.CodeReviewSettings }))
    @ApiOperation({ summary: 'Create an environment', description: 'One per connected repo (idempotent); asks the Runtime for its setup.' })
    createEnvironment(@Req() req: UserRequest, @Body() body: CreateRuntimeEnvironmentDto) {
        return this.createEnvironmentUseCase.execute({ user: req.user, repositoryId: body.repositoryId });
    }

    @Get(':id')
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({ summary: 'Get an environment', description: 'Metrics, blocked egress and egress approvals of one environment.' })
    getEnvironment(@Req() req: UserRequest, @Param('id') id: string) {
        return this.getEnvironmentUseCase.execute({ user: req.user, environmentId: id });
    }

    @Get(':id/blockers')
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({ summary: 'List environment blockers', description: 'Grouped by signature.' })
    listBlockers(@Req() req: UserRequest, @Param('id') id: string) {
        return this.listBlockersUseCase.execute({ user: req.user, environmentId: id });
    }

    // An owner, or a repo admin for an allow-host fix when the org lets them add hosts (D3); the use case decides.
    @Post(':id/blockers/fixes')
    @CheckPolicies(checkPermissions({ action: Action.Update, resource: ResourceType.CodeReviewSettings }))
    @ApiOperation({
        summary: 'Apply a blocker fix',
        description: 'A one-click fix runs now (allow a host, set up again); a recipe fix opens a PR with the one-field change on the default branch.',
    })
    applyBlockerFix(@Req() req: UserRequest, @Param('id') id: string, @Body() body: ApplyBlockerFixDto) {
        return this.applyBlockerFixUseCase.execute({ user: req.user, environmentId: id, signature: body.signature, fixId: body.fixId, mode: body.mode });
    }

    @Post(':id/recipe/propose')
    @CheckPolicies(checkPermissions({ action: Action.Update, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({
        summary: 'Open the inferred recipe PR',
        description: 'The default branch has no recipe and the one Kodus inferred booted from zero on two clean machines: opens the PR that adds it.',
    })
    proposeInferredRecipe(@Req() req: UserRequest, @Param('id') id: string) {
        return this.proposeInferredRecipeUseCase.execute({ user: req.user, environmentId: id });
    }

    @Get(':id/lessons')
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({ summary: 'List what Kody learned', description: "Lessons of this environment's repo and of the org: the fix that got a blocker past, and where it was proven." })
    listLessons(@Req() req: UserRequest, @Param('id') id: string) {
        return this.listLessonsUseCase.execute({ user: req.user, environmentId: id });
    }

    @Post(':id/lessons/:lessonId/promote')
    @HttpCode(202)
    @CheckPolicies(checkPermissions({ action: Action.Manage, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({ summary: 'Promote a lesson to the org', description: 'The lesson then applies to every repo of the org. Org admins only (ADR-018).' })
    promoteLesson(@Req() req: UserRequest, @Param('id') id: string, @Param('lessonId') lessonId: string) {
        return this.updateLessonUseCase.execute({ user: req.user, environmentId: id, lessonId, action: 'promote' });
    }

    @Post(':id/lessons/:lessonId/retire')
    @HttpCode(202)
    @CheckPolicies(checkPermissions({ action: Action.Manage, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({ summary: 'Retire a lesson', description: 'The lesson is no longer used. Org admins only.' })
    retireLesson(@Req() req: UserRequest, @Param('id') id: string, @Param('lessonId') lessonId: string) {
        return this.updateLessonUseCase.execute({ user: req.user, environmentId: id, lessonId, action: 'retire' });
    }

    @Post(':id/setup')
    @HttpCode(202)
    @CheckPolicies(checkPermissions({ action: Action.Update, resource: ResourceType.CodeReviewSettings }))
    @ApiOperation({ summary: 'Set up an environment', description: 'Asks the Runtime, through the outbox, to build the environment again.' })
    requestSetup(@Req() req: UserRequest, @Param('id') id: string) {
        return this.requestSetupUseCase.execute({ user: req.user, environmentId: id });
    }

    @Patch(':id/settings')
    @CheckPolicies(checkPermissions({ action: Action.Manage, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({
        summary: 'Update environment settings',
        description: "The diagnostic hold (a failed default-branch setup kept alive until its hard TTL, never a PR), the machine size (a preset, null for the cell's default), what a PR from a fork does (skip, require_approval, run) and the warm pool size (up to the plan's ceiling, null for its default).",
    })
    updateEnvironmentSettings(@Req() req: UserRequest, @Param('id') id: string, @Body() body: UpdateEnvironmentSettingsDto) {
        // Only the fields sent: an absent field is left as it is, a null pool size is the plan's default.
        // The validated DTO carries every declared field, undefined when not sent: those are absent.
        const fields = Object.fromEntries((['diagnosticHold', 'machineSize', 'forkPullRequests', 'poolSize', 'poolPolicy', 'previewSecrets'] as const).filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
        return this.updateEnvironmentSettingsUseCase.execute({ user: req.user, environmentId: id, body: fields });
    }

    @Post(':id/simulate')
    @HttpCode(202)
    @CheckPolicies(checkPermissions({ action: Action.Update, resource: ResourceType.CodeReviewSettings }))
    @ApiOperation({ summary: 'Simulate on past pull requests', description: 'Select prNumber or one to five unique prNumbers. Batch Runs are enqueued atomically; nothing is posted on the PRs.' })
    simulateRun(@Req() req: UserRequest, @Param('id') id: string, @Body() body: SimulateRunDto) {
        return this.simulateRunUseCase.execute({ user: req.user, environmentId: id, body });
    }

    @Get(':id/repositories')
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({ summary: "List an environment's repositories", description: 'The primary first, then the members by alias (also in GET :id as `repositories`).' })
    listRepositories(@Req() req: UserRequest, @Param('id') id: string) {
        return this.repositoriesUseCase.list({ user: req.user, environmentId: id });
    }

    @Post(':id/repositories')
    @HttpCode(202)
    @CheckPolicies(checkPermissions({ action: Action.Manage, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({
        summary: 'Add a repository to an environment',
        description: 'A connected repository boots beside the primary (ws/<alias>) and asks for a setup; Runs use the last good setup until it passes. Adding the same one again changes nothing. 409 on an alias taken or the primary itself.',
    })
    addRepository(@Req() req: UserRequest, @Param('id') id: string, @Body() body: AddEnvironmentRepositoryDto) {
        const fields = Object.fromEntries((['repositoryId', 'alias', 'triggers', 'pairBranches'] as const).filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
        return this.repositoriesUseCase.add({ user: req.user, environmentId: id, body: fields });
    }

    @Patch(':id/repositories/:repositoryId')
    @CheckPolicies(checkPermissions({ action: Action.Manage, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({ summary: "Change an environment's repository", description: 'Triggers, pair branches and alias; a new alias asks for a setup. 409 on an alias taken.' })
    updateRepository(@Req() req: UserRequest, @Param('id') id: string, @Param('repositoryId') repositoryId: string, @Body() body: UpdateEnvironmentRepositoryDto) {
        const fields = Object.fromEntries((['alias', 'triggers', 'pairBranches'] as const).filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
        return this.repositoriesUseCase.update({ user: req.user, environmentId: id, repositoryId, body: fields });
    }

    @Delete(':id/repositories/:repositoryId')
    @HttpCode(202)
    @CheckPolicies(checkPermissions({ action: Action.Manage, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({ summary: 'Remove a repository from an environment', description: 'Members only (409 for the primary); asks for a setup without it.' })
    removeRepository(@Req() req: UserRequest, @Param('id') id: string, @Param('repositoryId') repositoryId: string) {
        return this.repositoriesUseCase.remove({ user: req.user, environmentId: id, repositoryId });
    }
}
