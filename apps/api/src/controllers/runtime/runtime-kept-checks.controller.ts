import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { CheckPolicies, PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { KeepRuntimeCheckUseCase, ListRuntimeKeptChecksUseCase, RemoveRuntimeKeptCheckUseCase } from '@libs/runtime/api/application/use-cases/kept-checks.use-cases';

import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';
import { KeepRuntimeCheckDto, ListRuntimeKeptChecksQueryDto } from './runtime.dto';
import { RuntimeReleaseGuard } from './runtime-release.guard';

/**
 * Kody Runtime kept checks (docs/runtime/kept-checks.md): a regression's probe
 * kept so every later Run of the repository plays it. Keeping and removing are
 * gated like "Run again" (the use cases check the repository); listing is a
 * read of the environment. Another org's check or Run is 404.
 */
@ApiTags('Kody Runtime')
@ApiStandardResponses()
@Controller('runtime/kept-checks')
@UseGuards(RuntimeReleaseGuard)
export class RuntimeKeptChecksController {
    constructor(
        private readonly keepUseCase: KeepRuntimeCheckUseCase,
        private readonly listUseCase: ListRuntimeKeptChecksUseCase,
        private readonly removeUseCase: RemoveRuntimeKeptCheckUseCase,
    ) {}

    @Get()
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({ summary: 'List kept checks', description: 'The active kept checks of an environment, stale ones first, each with its last outcome, and the regressions they blocked.' })
    list(@Req() req: UserRequest, @Query() query: ListRuntimeKeptChecksQueryDto) {
        return this.listUseCase.execute({ user: req.user, environmentId: query.environmentId, repositoryId: query.repositoryId });
    }

    @Post()
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    // Keeping changes what every later PR of the repository runs: gated like "Run again" (repo scope).
    @CheckPolicies(checkPermissions({ action: Action.Create, resource: ResourceType.RuntimeRun }))
    @ApiOperation({ summary: 'Keep a check', description: "Keeps a regression finding's recorded probe, with main's answer as its expectation. Idempotent per probe." })
    keep(@Req() req: UserRequest, @Body() body: KeepRuntimeCheckDto) {
        return this.keepUseCase.execute({ user: req.user, body: { runId: body.runId, probeId: body.probeId } });
    }

    @Delete(':id')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Create, resource: ResourceType.RuntimeRun }))
    @ApiOperation({ summary: 'Remove a kept check', description: 'No later Run carries it; its past outcomes stay for the metric.' })
    remove(@Req() req: UserRequest, @Param('id') id: string) {
        return this.removeUseCase.execute({ user: req.user, keptCheckId: id });
    }
}
