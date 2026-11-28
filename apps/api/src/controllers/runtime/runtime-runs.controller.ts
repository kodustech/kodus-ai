import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import type { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { CheckPolicies, PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import type { RuntimePrincipal } from '@libs/runtime/api/application/run-access.service';
import { ApproveForkRunUseCase } from '@libs/runtime/api/application/use-cases/approve-fork-run.use-case';
import { SetFindingFeedbackUseCase } from '@libs/runtime/api/application/use-cases/finding-feedback.use-case';
import { SetFindingIntentUseCase } from '@libs/runtime/api/application/use-cases/finding-intent.use-case';
import { GetRuntimeRunEvidenceUseCase } from '@libs/runtime/api/application/use-cases/get-run-evidence.use-case';
import { GetRuntimeRunReproductionUseCase } from '@libs/runtime/api/application/use-cases/get-run-reproduction.use-case';
import { GetRuntimeRunUseCase } from '@libs/runtime/api/application/use-cases/get-run.use-case';
import { ListRuntimeRunsUseCase } from '@libs/runtime/api/application/use-cases/list-runs.use-case';
import { ReadRuntimeRunStreamUseCase } from '@libs/runtime/api/application/use-cases/read-run-stream.use-case';
import { RunRuntimeAgainUseCase } from '@libs/runtime/api/application/use-cases/run-again.use-case';
import { GetRuntimeRunSuiteArtifactUseCase, GetRuntimeRunSuiteUseCase, RetryRuntimeRunSuiteUseCase } from '@libs/runtime/api/application/use-cases/suite.use-cases';
import { RUNTIME_PRINCIPAL, RuntimeReaderAuthGuard } from '@libs/runtime/api/infrastructure/runtime-reader.guard';

import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';
import { FindingFeedbackDto, FindingIntentDto, ListRuntimeRunsQueryDto, ReadRunStreamQueryDto, RunAgainDto, RunEvidenceQueryDto, SuiteArtifactQueryDto } from './runtime.dto';
import { RuntimeReleaseGuard } from './runtime-release.guard';

/**
 * Kody Runtime Runs (§7). Every route loads the Run and checks org, team and
 * repo of the caller (RuntimeRunAccessService); a Run of another org is 404.
 */
@ApiTags('Kody Runtime')
@ApiStandardResponses()
@Controller('runtime/runs')
@UseGuards(RuntimeReleaseGuard)
export class RuntimeRunsController {
    constructor(
        private readonly listRunsUseCase: ListRuntimeRunsUseCase,
        private readonly getRunUseCase: GetRuntimeRunUseCase,
        private readonly readStreamUseCase: ReadRuntimeRunStreamUseCase,
        private readonly getEvidenceUseCase: GetRuntimeRunEvidenceUseCase,
        private readonly runAgainUseCase: RunRuntimeAgainUseCase,
        private readonly approveForkUseCase: ApproveForkRunUseCase,
        private readonly setFeedbackUseCase: SetFindingFeedbackUseCase,
        private readonly getReproductionUseCase: GetRuntimeRunReproductionUseCase,
        private readonly setIntentUseCase: SetFindingIntentUseCase,
        private readonly getSuiteUseCase: GetRuntimeRunSuiteUseCase,
        private readonly retrySuiteUseCase: RetryRuntimeRunSuiteUseCase,
        private readonly suiteArtifactUseCase: GetRuntimeRunSuiteArtifactUseCase,
    ) {}

    @Get()
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeRun }))
    @ApiOperation({ summary: 'List Runtime runs', description: 'Runs of the caller org, optionally for one repository and one PR.' })
    listRuns(@Req() req: UserRequest, @Query() query: ListRuntimeRunsQueryDto) {
        return this.listRunsUseCase.execute({ user: req.user, repositoryId: query.repositoryId, limit: query.limit, prNumber: query.prNumber });
    }

    @Put(':id/findings/:probeId/feedback')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    // Any reader of the Run votes: the vote is the reader's own opinion, not a change to the Run.
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeRun }))
    @ApiOperation({ summary: 'Rate a tested path', description: 'One vote per user and path; null clears it.' })
    setFindingFeedback(@Req() req: UserRequest, @Param('id') id: string, @Param('probeId') probeId: string, @Body() body: FindingFeedbackDto) {
        return this.setFeedbackUseCase.execute({ user: req.user, runId: id, probeId, body: { value: body.value } });
    }

    @Put(':id/findings/:probeId/intent')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    // A developer's call on the change, gated like "Run again" (repo scope). It is a learning
    // signal: it does not change the Run, its check or the PR comment, and publishes nothing.
    @CheckPolicies(checkPermissions({ action: Action.Create, resource: ResourceType.RuntimeRun }))
    @ApiOperation({ summary: 'Mark a finding as intended', description: 'One mark per finding; false clears it. The check keeps what Kody measured.' })
    setFindingIntent(@Req() req: UserRequest, @Param('id') id: string, @Param('probeId') probeId: string, @Body() body: FindingIntentDto) {
        return this.setIntentUseCase.execute({ user: req.user, runId: id, probeId, body: { intended: body.intended } });
    }

    @Get(':id/findings/:probeId/reproduce')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    // Read-only recorded data; no boot commands or executable host artifact.
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeRun }))
    @ApiOperation({ summary: 'Get reproduction data', description: 'Versioned JSON with recorded identities, a redacted external probe and observations. Data only; no isolated replay is performed.' })
    @ApiOkResponse({ description: '{ filename: *.json, manifest: { schemaVersion: 1, kind, run, probe } }' })
    getReproduction(@Req() req: UserRequest, @Res({ passthrough: true }) res: Response, @Param('id') id: string, @Param('probeId') probeId: string) {
        res.setHeader('Cache-Control', 'private, no-store');
        return this.getReproductionUseCase.execute({ principal: { kind: 'user', user: req.user }, runId: id, probeId });
    }

    @Get(':id/suite')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeRun }))
    @ApiOperation({ summary: "Get a Run's e2e suite", description: "The Run page's e2e suite tab: how the specs were chosen, the failed tests by whose fault they are, the shards. 404 when the Run has no suite." })
    getSuite(@Req() req: UserRequest, @Param('id') id: string) {
        return this.getSuiteUseCase.execute({ user: req.user, runId: id });
    }

    @Post(':id/suite/retry')
    @HttpCode(202)
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    // It starts the repository's tests again: gated like "Run again" (repo scope), and the product mints the tokens.
    @CheckPolicies(checkPermissions({ action: Action.Create, resource: ResourceType.RuntimeRun }))
    @ApiOperation({ summary: 'Re-run the failed specs', description: "A suite run of the specs that did not pass, through the outbox (RuntimeSuiteRetried, scope failed). Conflict while the suite runs or when nothing is left to run." })
    retrySuite(@Req() req: UserRequest, @Param('id') id: string) {
        return this.retrySuiteUseCase.execute({ user: req.user, runId: id });
    }

    @Get(':id/suite/artifacts')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeRun }))
    @ApiOperation({ summary: 'Get a suite artifact URL', description: 'Signed URL of at most 5 minutes for a file kept for a failed spec (trace, screenshot, log). The key is the one the suite run stored, never one the caller names.' })
    @ApiOkResponse({ description: '{ url, expiresAt, key }' })
    async getSuiteArtifact(@Req() req: UserRequest, @Res({ passthrough: true }) res: Response, @Param('id') id: string, @Query() query: SuiteArtifactQueryDto) {
        res.setHeader('Cache-Control', 'private, no-store');
        return this.suiteArtifactUseCase.execute({ user: req.user, runId: id, spec: query.spec, name: query.name });
    }

    @Get(':id')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeRun }))
    @ApiOperation({ summary: 'Get a Runtime run', description: 'Steps, findings, coverage and cost of one Run.' })
    getRun(@Req() req: UserRequest, @Param('id') id: string) {
        return this.getRunUseCase.execute({ principal: { kind: 'user', user: req.user }, runId: id });
    }

    /**
     * Durable Streams read (ADR-047). Body: JSON array of events. Headers:
     * Stream-Next-Offset (opaque, resume from it) and Stream-Up-To-Date.
     * `live=long-poll` waits up to ~20 s and answers 204 when nothing came.
     * Auth: dashboard JWT with Read on RuntimeRun, or a team key with runs:read
     * on that repo (checked in the use case, hence @Public + own guard).
     */
    @Get(':id/stream')
    @Public()
    // The team key's org is known only after its guard: the release guard asks again.
    @UseGuards(RuntimeReaderAuthGuard, RuntimeReleaseGuard)
    @ApiBearerAuth('jwt')
    @ApiHeader({ name: 'x-team-key', required: false, description: 'Team key with runs:read on the repository' })
    @ApiOperation({ summary: 'Read the Run stream', description: 'Catch-up or long-poll read from an opaque offset.' })
    async readRunStream(
        @Req() req: UserRequest & { [RUNTIME_PRINCIPAL]?: RuntimePrincipal },
        @Res({ passthrough: true }) res: Response,
        @Param('id') id: string,
        @Query() query: ReadRunStreamQueryDto,
    ) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.on?.('close', abort);
        try {
            const page = await this.readStreamUseCase.execute({
                principal: req[RUNTIME_PRINCIPAL]!,
                runId: id,
                offset: query.offset,
                live: query.live,
                signal: controller.signal,
            });
            res.setHeader('Cache-Control', 'private, no-store');
            res.setHeader('Stream-Next-Offset', page.nextOffset);
            res.setHeader('Stream-Up-To-Date', String(page.upToDate));
            res.status(page.status);
            return page.status === 204 ? undefined : page.events;
        } finally {
            req.off?.('close', abort);
        }
    }

    @Get(':id/evidence/:stepId')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeRun }))
    @ApiOperation({ summary: 'Get an evidence URL', description: 'Signed URL of at most 5 minutes for the exact evidence key.' })
    @ApiOkResponse({ description: '{ url, expiresAt, key }' })
    async getEvidenceUrl(
        @Req() req: UserRequest,
        @Res({ passthrough: true }) res: Response,
        @Param('id') id: string,
        @Param('stepId') stepId: string,
        @Query() query: RunEvidenceQueryDto,
    ) {
        res.setHeader('Cache-Control', 'private, no-store');
        return this.getEvidenceUseCase.execute({ user: req.user, runId: id, stepId, side: query.side, type: query.type });
    }

    @Post()
    @HttpCode(202)
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Create, resource: ResourceType.RuntimeRun }))
    @ApiOperation({ summary: 'Run again', description: 'New runId with attempt + 1 for a finished Run, through the outbox.' })
    runAgain(@Req() req: UserRequest, @Body() body: RunAgainDto) {
        return this.runAgainUseCase.execute({ user: req.user, runId: body.runId });
    }

    @Post(':id/approvals')
    @HttpCode(202)
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    // An approval starts a fork's code: a write, gated like "Run again". The use
    // case then needs write on the repo per the Git API and refuses the PR author;
    // until a Kodus user is linked to a verified Git identity it refuses everyone.
    @CheckPolicies(checkPermissions({ action: Action.Create, resource: ResourceType.RuntimeRun }))
    @ApiOperation({
        summary: 'Approve a fork Run',
        description: 'Binds the approval to the current head SHA; needs write on the repo per the Git API, and not the PR author.',
    })
    approveForkRun(@Req() req: UserRequest, @Param('id') id: string) {
        return this.approveForkUseCase.execute({ user: req.user, runId: id });
    }
}
